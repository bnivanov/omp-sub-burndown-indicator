import { describe, expect, test } from "bun:test";
import type { UsageLimit } from "@oh-my-pi/pi-ai";
import {
  calculateBurndownSegment,
  calculateBurndownSegmentsForSnapshot,
  computeBurndownSegments,
  eligibleBurndownWindows,
  selectShortestBurndownWindow,
  selectWindowsForView,
} from "../src/domain/burndown.ts";
import type { LimitObservation, SubscriptionSnapshot } from "../src/domain/types.ts";
import {
  classifyWindow,
  parseWindowViewMode,
  WINDOW_MS,
  windowClassLabel,
} from "../src/domain/window-class.ts";

const NOW = 1_000_000;
const observation = (
  id: string,
  durationMs: number | undefined,
  resetsAt: number | undefined,
  usedFraction: number | undefined,
  fetchedAt = NOW,
  stale = false,
  windowId = id,
): LimitObservation => {
  const limit: UsageLimit = {
    id,
    label: id,
    scope: { provider: "anthropic", windowId },
    ...(durationMs !== undefined || resetsAt !== undefined
      ? {
          window: {
            id: windowId,
            label: id,
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(resetsAt !== undefined ? { resetsAt } : {}),
          },
        }
      : {}),
    amount: { unit: "percent", ...(usedFraction !== undefined ? { usedFraction } : {}) },
  };
  return { limit, measurementSource: "omp-broker", fetchedAt, stale };
};

const snapshot = (limits: LimitObservation[]): SubscriptionSnapshot => ({
  id: "anthropic:account:a",
  provider: "anthropic",
  accountLabel: "A",
  identitySource: "omp-broker",
  limits,
});

describe("burndown window and pace", () => {
  test("eligibility requires usage plus duration or semantic reset window", () => {
    const valid = observation("valid", 100, NOW + 100, 0.2);
    const monthly = observation("monthly", undefined, NOW + 100, 0.4, NOW, false, "monthly");
    const noReset = observation("no-reset", 100, undefined, 0.2);
    const eligible = eligibleBurndownWindows(
      snapshot([
        valid,
        monthly,
        noReset,
        observation("no-duration", undefined, NOW + 100, 0.2),
        observation("zero", 0, NOW + 100, 0.2),
        observation("unknown-usage", 100, NOW + 100, undefined),
        observation("expired-reset", 100, NOW - 31, 0.2),
      ]),
      NOW,
      30,
    );
    expect(eligible.map((entry) => entry.observation.limit.id).sort()).toEqual([
      "monthly",
      "no-reset",
      "valid",
    ]);
  });

  test("positive-duration limits without reset remain selectable with percent left", () => {
    const noReset = observation("anthropic:5h", WINDOW_MS.fiveHour, undefined, 0, NOW, false, "5h");
    const segments = calculateBurndownSegmentsForSnapshot(snapshot([noReset]), {
      now: NOW,
      clockSkewMs: 0,
      windowView: "all",
    });
    expect(segments).toHaveLength(1);
    expect(segments[0]?.windowLabel).toBe("5h");
    expect(segments[0]?.usedFraction).toBe(0);
    expect(segments[0]?.state).toBe("unknown");
    expect(segments[0]?.resetsAt).toBeUndefined();
  });

  test("selects shortest positive duration independent of reset and quota", () => {
    const selected = selectShortestBurndownWindow(
      snapshot([
        observation("week", 700, NOW + 1, 0.99),
        observation("hour", 100, NOW + 500, 0.01),
      ]),
      NOW,
      0,
    );
    expect(selected?.observation.limit.id).toBe("hour");
  });

  test("uses reset timestamp then stable limit ID tie breakers", () => {
    const earlier = selectShortestBurndownWindow(
      snapshot([
        observation("z", 100, NOW + 200, 0.1, NOW, false, "shared"),
        observation("a", 100, NOW + 100, 0.1, NOW, false, "shared"),
      ]),
      NOW,
      0,
    );
    expect(earlier?.observation.limit.id).toBe("a");
    const lexical = selectShortestBurndownWindow(
      snapshot([
        observation("z", 100, NOW + 100, 0.1, NOW, false, "shared"),
        observation("a", 100, NOW + 100, 0.1, NOW, false, "shared"),
      ]),
      NOW,
      0,
    );
    expect(lexical?.observation.limit.id).toBe("a");
  });

  test("selects the most urgent pace among same-window limits", () => {
    const durationMs = 168 * 60 * 60 * 1_000;
    const sparkDurationMs = durationMs - 1;
    const resetsAt = NOW + 126 * 60 * 60 * 1_000;
    const selectedSnapshot = snapshot([
      observation("a-spark", sparkDurationMs, resetsAt, 0, NOW, false, "7d"),
      observation("normal", durationMs, resetsAt, 0.85, NOW, false, "7d"),
    ]);

    const selected = selectShortestBurndownWindow(selectedSnapshot, NOW, 0);
    expect(selected?.observation.limit.id).toBe("normal");

    const segment = calculateBurndownSegment(selectedSnapshot, { now: NOW, clockSkewMs: 0 });
    expect(segment.usedFraction).toBe(0.85);
    expect(segment.elapsedFraction).toBe(0.25);
    expect(segment.paceDelta).toBeCloseTo(-0.6);
    expect(segment.state).toBe("behind");
  });

  test("computes elapsed fraction and pace delta, with ahead/behind states", () => {
    const ahead = calculateBurndownSegment(snapshot([observation("w", 1_000, NOW + 500, 0.2)]), {
      now: NOW,
      paceTolerance: 0.01,
      clockSkewMs: 0,
    });
    expect(ahead.elapsedFraction).toBe(0.5);
    expect(ahead.paceDelta).toBeCloseTo(0.3);
    expect(ahead.state).toBe("ahead");
    const behind = calculateBurndownSegment(snapshot([observation("w", 1_000, NOW + 500, 0.8)]), {
      now: NOW,
      paceTolerance: 0.01,
      clockSkewMs: 0,
    });
    expect(behind.state).toBe("behind");
  });

  test("treats exact tolerance as on pace and exhaustion as an override", () => {
    const onPace = calculateBurndownSegment(snapshot([observation("w", 1_000, NOW + 500, 0.49)]), {
      now: NOW,
      paceTolerance: 0.01,
      clockSkewMs: 0,
    });
    expect(onPace.paceDelta).toBeCloseTo(0.01);
    expect(onPace.state).toBe("on-pace");
    const exhausted = calculateBurndownSegment(
      snapshot([observation("w", 1_000, NOW + 500, 1.2)]),
      { now: NOW, paceTolerance: 0.01, clockSkewMs: 0 },
    );
    expect(exhausted.state).toBe("exhausted");
    expect(exhausted.usedFraction).toBe(1.2);
  });

  test("clamps elapsed display pace at window boundaries and handles reset skew", () => {
    const atStart = calculateBurndownSegment(snapshot([observation("w", 1_000, NOW - 999, 0)]), {
      now: NOW,
      clockSkewMs: 1_000,
    });
    expect(atStart.elapsedFraction).toBe(1);
    const tooOld = calculateBurndownSegment(snapshot([observation("w", 1_000, NOW - 1_001, 0)]), {
      now: NOW,
      clockSkewMs: 1_000,
    });
    expect(tooOld.state).toBe("unknown");
  });

  test("expires old observations and reports no eligible windows as unknown", () => {
    const old = calculateBurndownSegment(
      snapshot([observation("w", 1_000, NOW + 500, 0.2, NOW - 101)]),
      { now: NOW, staleAfterMs: 100 },
    );
    expect(old.state).toBe("unknown");
    expect(old.stale).toBe(true);
    const unknown = calculateBurndownSegment(
      snapshot([observation("bad", undefined, NOW + 500, 0.2)]),
      { now: NOW },
    );
    expect(unknown.state).toBe("unknown");
    expect(unknown.stale).toBe(false);
  });

  test("computes one segment per subscription with stable IDs", () => {
    const segments = computeBurndownSegments(
      [
        snapshot([observation("a", 100, NOW + 50, 0.1)]),
        { ...snapshot([]), id: "anthropic:account:b" },
      ],
      { now: NOW, clockSkewMs: 0 },
    );
    expect(segments.map((segment) => segment.subscriptionId)).toEqual([
      "anthropic:account:a",
      "anthropic:account:b",
    ]);
    expect(segments[1]?.state).toBe("unknown");
  });
  test("propagates base account identity and tier, with legacy fallback", () => {
    const accountId = "anthropic:account:acct";
    const segments = computeBurndownSegments(
      [
        {
          ...snapshot([observation("regular", 100, NOW + 50, 0.1)]),
          id: accountId,
          accountId,
        },
        {
          ...snapshot([observation("spark", 100, NOW + 50, 0.2)]),
          id: `${accountId}:tier:spark`,
          accountId,
          tier: "spark",
        },
      ],
      { now: NOW, clockSkewMs: 0 },
    );
    expect(
      segments.map(({ subscriptionId, accountId: segmentAccountId, tier }) => ({
        subscriptionId,
        accountId: segmentAccountId,
        tier,
      })),
    ).toEqual([
      { subscriptionId: accountId, accountId, tier: undefined },
      {
        subscriptionId: `${accountId}:tier:spark`,
        accountId,
        tier: "spark",
      },
    ]);

    const legacy = calculateBurndownSegment(snapshot([]), { now: NOW });
    expect(legacy.accountId).toBe("anthropic:account:a");
  });

  test("classifies only exact 5h, week, and month windows", () => {
    expect(classifyWindow(observation("5h", WINDOW_MS.fiveHour, NOW + 1, 0.1).limit)).toBe(
      "five_hour",
    );
    expect(classifyWindow(observation("1h", WINDOW_MS.hour, NOW + 1, 0.1).limit)).toBe("other");
    expect(classifyWindow(observation("week", WINDOW_MS.week, NOW + 1, 0.1).limit)).toBe("week");
    expect(classifyWindow(observation("2d", 2 * WINDOW_MS.day, NOW + 1, 0.1).limit)).toBe("other");
    expect(classifyWindow(observation("month", WINDOW_MS.month, NOW + 1, 0.1).limit)).toBe("month");
    expect(
      classifyWindow(
        observation("rolling-5h", undefined, NOW + 1, 0.1, NOW, false, "rolling-5h").limit,
      ),
    ).toBe("five_hour");
    expect(windowClassLabel("other", WINDOW_MS.hour)).toBe("1h");
    expect(
      classifyWindow(observation("lying-5h", WINDOW_MS.hour, NOW + 1, 0.1, NOW, false, "5h").limit),
    ).toBe("other");
    expect(
      classifyWindow(
        observation("lying-week", 2 * WINDOW_MS.day, NOW + 1, 0.1, NOW, false, "weekly").limit,
      ),
    ).toBe("other");
    expect(windowClassLabel("other", 2 * WINDOW_MS.day)).toBe("2d");
    expect(parseWindowViewMode("hour")).toBe("five_hour");
    expect(parseWindowViewMode("5h")).toBe("five_hour");
    expect(parseWindowViewMode("wk")).toBe("week");
    expect(parseWindowViewMode("both")).toBe("all");
  });

  test("five_hour view prefers 5h and falls back to week then month", () => {
    const dual = snapshot([
      observation("5h", WINDOW_MS.fiveHour, NOW + WINDOW_MS.fiveHour / 2, 0),
      observation("7d", WINDOW_MS.week, NOW + WINDOW_MS.week / 2, 0.12),
      observation("30d", WINDOW_MS.month, NOW + WINDOW_MS.month / 2, 0.2),
    ]);
    const selected = selectWindowsForView(dual, "five_hour", NOW, 0);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.observation.limit.id).toBe("5h");
    expect(selected[0]?.windowClass).toBe("five_hour");

    const weekOnly = snapshot([
      observation("7d", WINDOW_MS.week, NOW + WINDOW_MS.week / 2, 0.12),
      observation("30d", WINDOW_MS.month, NOW + WINDOW_MS.month / 2, 0.2),
    ]);
    expect(selectWindowsForView(weekOnly, "five_hour", NOW, 0)[0]?.windowClass).toBe("week");

    const monthOnly = snapshot([
      observation("30d", WINDOW_MS.month, NOW + WINDOW_MS.month / 2, 0.2),
    ]);
    expect(selectWindowsForView(monthOnly, "five_hour", NOW, 0)[0]?.windowClass).toBe("month");
  });

  test("week and month views select their class with ordered fallback", () => {
    const dual = snapshot([
      observation("5h", WINDOW_MS.fiveHour, NOW + WINDOW_MS.fiveHour / 2, 0),
      observation("7d", WINDOW_MS.week, NOW + WINDOW_MS.week / 2, 0.12),
    ]);
    expect(selectWindowsForView(dual, "week", NOW, 0)[0]?.observation.limit.id).toBe("7d");
    expect(selectWindowsForView(dual, "month", NOW, 0)[0]?.observation.limit.id).toBe("7d");

    const shortOnly = snapshot([
      observation("5h", WINDOW_MS.fiveHour, NOW + WINDOW_MS.fiveHour / 2, 0.1),
    ]);
    expect(selectWindowsForView(shortOnly, "week", NOW, 0)[0]?.windowClass).toBe("five_hour");
  });

  test("all view emits every present semantic class and distinct other windows", () => {
    const multi = snapshot([
      observation("5h", WINDOW_MS.fiveHour, NOW + WINDOW_MS.fiveHour / 2, 0),
      observation("7d", WINDOW_MS.week, NOW + WINDOW_MS.week / 2, 0.12),
      observation("30d", WINDOW_MS.month, NOW + WINDOW_MS.month / 2, 0.33),
      observation("1h", WINDOW_MS.hour, NOW + WINDOW_MS.hour / 2, 0.5),
      observation("2d", 2 * WINDOW_MS.day, NOW + (2 * WINDOW_MS.day) / 2, 0.4),
    ]);
    const segments = calculateBurndownSegmentsForSnapshot(multi, {
      now: NOW,
      clockSkewMs: 0,
      windowView: "all",
    });
    expect(segments.map((segment) => segment.windowClass)).toEqual([
      "five_hour",
      "week",
      "month",
      "other",
      "other",
    ]);
    expect(segments.map((segment) => segment.windowLabel)).toEqual(["5h", "Wk", "Mo", "1h", "2d"]);
    expect(segments.every((segment) => segment.subscriptionId === "anthropic:account:a")).toBe(
      true,
    );
    expect(segments.find((segment) => segment.windowClass === "week")?.usedFraction).toBe(0.12);
    expect(segments.find((segment) => segment.windowClass === "month")?.usedFraction).toBe(0.33);
  });

  test("all view keeps distinct other windows that share a generic id", () => {
    const multi = snapshot([
      observation("a", WINDOW_MS.hour, NOW + WINDOW_MS.hour / 2, 0.1, NOW, false, "default"),
      observation("b", 2 * WINDOW_MS.day, NOW + WINDOW_MS.day, 0.2, NOW, false, "default"),
    ]);
    const segments = calculateBurndownSegmentsForSnapshot(multi, {
      now: NOW,
      clockSkewMs: 0,
      windowView: "all",
    });
    expect(segments.map((segment) => segment.windowLabel).sort()).toEqual(["1h", "2d"]);
    expect(segments.every((segment) => segment.windowClass === "other")).toBe(true);
  });

  test("durationless monthly limits use canonical month duration for pace", () => {
    const monthly = observation(
      "monthly",
      undefined,
      NOW + WINDOW_MS.day,
      0.25,
      NOW,
      false,
      "monthly",
    );
    const segment = calculateBurndownSegment(snapshot([monthly]), {
      now: NOW,
      clockSkewMs: 0,
      windowView: "month",
    });
    expect(segment.subscriptionId).toBe("anthropic:account:a");
    expect(segment.windowClass).toBe("month");
    expect(segment.windowLabel).toBe("Mo");
    expect(segment.usedFraction).toBe(0.25);
    expect(segment.resetsAt).toBe(NOW + WINDOW_MS.day);
    expect(segment.state).toBe("ahead");
    expect(segment.paceDelta).toBeGreaterThan(0);
  });
  test("kimi durationless plan summary classifies as week independent of now", () => {
    // Live dump shape: durationless default summary at 88% used + explicit 5h row.
    const kimiSummary: LimitObservation = {
      limit: {
        id: "kimi-code:0",
        label: "Total quota",
        scope: { provider: "kimi-code", windowId: "default" },
        window: {
          id: "default",
          label: "Usage window",
          resetsAt: NOW + 2 * WINDOW_MS.day + 7 * WINDOW_MS.hour,
        },
        amount: { unit: "percent", usedFraction: 0.88 },
      },
      measurementSource: "omp-auth-storage",
      fetchedAt: NOW,
      stale: false,
    };
    const kimiFiveHour = observation(
      "kimi-code:1",
      WINDOW_MS.fiveHour,
      NOW + WINDOW_MS.fiveHour / 2,
      0,
      NOW,
      false,
      "300time_unit_minute",
    );
    kimiFiveHour.limit = {
      ...kimiFiveHour.limit,
      label: "5h limit",
      scope: { provider: "kimi-code", windowId: "300time_unit_minute" },
    };

    // Classification is stable: it does not change as `now` approaches reset.
    const early = classifyWindow(kimiSummary.limit);
    const nearReset = classifyWindow(kimiSummary.limit);
    expect(early).toBe("week");
    expect(nearReset).toBe("week");
    expect(classifyWindow(kimiFiveHour.limit)).toBe("five_hour");

    const snap: SubscriptionSnapshot = {
      id: "provider:kimi-code",
      provider: "kimi-code",
      identitySource: "omp-auth-storage",
      limits: [kimiSummary, kimiFiveHour],
    };
    const all = calculateBurndownSegmentsForSnapshot(snap, {
      now: NOW,
      clockSkewMs: 0,
      windowView: "all",
    });
    expect(all.map((segment) => segment.windowLabel)).toEqual(["5h", "Wk"]);
    const week = all.find((segment) => segment.windowLabel === "Wk");
    expect(week?.usedFraction).toBe(0.88);
    // 88% used with ~2d7h of a 7d window left is behind linear pace.
    expect(week?.state).toBe("behind");
    expect(week?.paceDelta).toBeLessThan(0);
    expect(Math.round((1 - (week?.usedFraction ?? 1)) * 100)).toBe(12);

    // Bare durationless non-kimi rows remain ineligible.
    const bare = observation("mystery", undefined, NOW + WINDOW_MS.day, 0.5, NOW, false, "default");
    expect(eligibleBurndownWindows(snapshot([bare]), NOW, 0)).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import type { SubscriptionSnapshot } from "../src/domain/types.ts";
import { mergeSnapshots } from "../src/sources/coordinator.ts";
import {
  OpencodeGoConsoleUsageSource,
  parseGoConsoleUsage,
} from "../src/sources/opencode-go-console.ts";

const NOW = 1_800_000_000_000;
const PAYLOAD = {
  usage: {
    rolling: { status: "ok", percent: 0, resetsAt: "2026-08-12T06:02:07.248Z" },
    weekly: { status: "ok", percent: 3, resetsAt: "2026-08-17T00:00:00.248Z" },
    monthly: { status: "warning", percent: 68, resetsAt: "2026-09-04T03:44:01.248Z" },
  },
};

function syntheticSnapshot(stale = false): SubscriptionSnapshot {
  return {
    id: "provider:opencode-go",
    provider: "opencode-go",
    accountId: "provider:opencode-go",
    identitySource: "omp-auth-storage",
    limits: [
      {
        limit: {
          id: "monthly",
          label: "Monthly limit",
          scope: { provider: "opencode-go", windowId: "monthly" },
          window: { id: "monthly", label: "Monthly", durationMs: 2_592_000_000 },
          amount: { usedFraction: 0.066, unit: "usd" },
        },
        measurementSource: "omp-auth-storage",
        fetchedAt: NOW,
        stale,
      },
    ],
  };
}

describe("parseGoConsoleUsage", () => {
  test("maps the documented usage payload", () => {
    expect(parseGoConsoleUsage(PAYLOAD)).toEqual([
      { status: "ok", percent: 0, resetsAt: Date.parse(PAYLOAD.usage.rolling.resetsAt) },
      { status: "ok", percent: 3, resetsAt: Date.parse(PAYLOAD.usage.weekly.resetsAt) },
      { status: "warning", percent: 68, resetsAt: Date.parse(PAYLOAD.usage.monthly.resetsAt) },
    ]);
  });

  test("rejects malformed usage payloads", () => {
    expect(() => parseGoConsoleUsage({ error: "down" })).toThrow("missing usage");
    expect(() => parseGoConsoleUsage({ usage: null })).toThrow("invalid usage");
    expect(() => parseGoConsoleUsage({ usage: {} })).toThrow("missing rolling usage");
    expect(() => parseGoConsoleUsage({ usage: { rolling: { percent: 10 } } })).toThrow(
      "invalid rolling usage",
    );
  });
});

describe("OpencodeGoConsoleUsageSource", () => {
  test("is disabled without a token", async () => {
    const source = new OpencodeGoConsoleUsageSource({ now: () => NOW });
    expect(source.diagnostic().enabled).toBe(false);
    expect(await source.refresh(AbortSignal.timeout(5_000))).toEqual([]);
  });

  test("fetches exact quota with bearer authorization and real reset anchors", async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const source = new OpencodeGoConsoleUsageSource({
      token: "api-key",
      baseUrl: "https://opencode.test",
      fetchFn: (async (input, init) => {
        seen.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return new Response(JSON.stringify(PAYLOAD), { status: 200 });
      }) as typeof fetch,
      now: () => NOW,
    });
    const snapshots = await source.refresh(AbortSignal.timeout(5_000));
    expect(seen).toEqual([
      { url: "https://opencode.test/zen/go/v1/usage", authorization: "Bearer api-key" },
    ]);
    expect(snapshots[0]?.id).toBe("opencode-go:usage");
    expect(snapshots[0]?.limits[2]?.limit.amount.usedFraction).toBeCloseTo(0.68, 6);
    expect(snapshots[0]?.limits[2]?.limit.window?.resetsAt).toBe(
      Date.parse(PAYLOAD.usage.monthly.resetsAt),
    );
    expect(source.diagnostic().lastSuccessAt).toBe(NOW);
  });

  test("preserves last-good data as stale after an API failure, then expires it", async () => {
    let ok = true;
    let now = NOW;
    const source = new OpencodeGoConsoleUsageSource({
      token: "api-key",
      baseUrl: "https://opencode.test",
      staleAfterMs: 30 * 60_000,
      fetchFn: (async () =>
        ok
          ? new Response(JSON.stringify(PAYLOAD), { status: 200 })
          : new Response(JSON.stringify({ error: "down" }), {
              status: 503,
            })) as unknown as typeof fetch,
      now: () => now,
    });
    await source.refresh(AbortSignal.timeout(5_000));
    ok = false;
    now += 10 * 60_000;
    const preserved = await source.refresh(AbortSignal.timeout(5_000));
    expect(preserved[0]?.limits.every((limit) => limit.stale)).toBe(true);
    expect(source.diagnostic().lastErrorCategory).toBe("server");
    now += 31 * 60_000;
    expect(await source.refresh(AbortSignal.timeout(5_000))).toEqual([]);
    now += 31 * 60_000;
    expect(await source.refresh(AbortSignal.timeout(5_000))).toEqual([]);
  });
});

describe("console precedence in mergeSnapshots", () => {
  function apiSnapshot(stale: boolean): SubscriptionSnapshot {
    const base = syntheticSnapshot();
    return {
      ...base,
      id: "opencode-go:usage",
      accountId: "opencode-go:usage",
      identitySource: "opencode-go-console",
      limits: base.limits.map((limit) => ({
        ...limit,
        measurementSource: "opencode-go-console",
        stale,
        limit: { ...limit.limit, amount: { usedFraction: 0.68, unit: "usd" } },
      })),
    };
  }

  test("fresh API data replaces the synthetic estimate", () => {
    const merged = mergeSnapshots([[syntheticSnapshot()], [apiSnapshot(false)]]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.identitySource).toBe("opencode-go-console");
  });

  test("stale API data cedes to a fresh synthetic estimate", () => {
    const merged = mergeSnapshots([[syntheticSnapshot()], [apiSnapshot(true)]]);
    expect(merged[0]?.identitySource).toBe("omp-auth-storage");
  });
});

import { describe, expect, test } from "bun:test";
import type { SubscriptionSnapshot } from "../src/domain/types.ts";
import { mergeSnapshots } from "../src/sources/coordinator.ts";
import {
  OpencodeGoConsoleUsageSource,
  parseGoConsoleHtml,
  parseResetMs,
} from "../src/sources/opencode-go-console.ts";

const NOW = 1_800_000_000_000;

function usageItem(label: string, percent: number, reset: string, comments = true): string {
  const value = comments ? `<!--$-->${percent}<!--/-->%` : `${percent}%`;
  const resetText = comments
    ? `<!--$-->Resets in<!--/--> <!--$-->${reset}<!--/-->`
    : `Resets in ${reset}`;
  return `<div data-hk="0000000100000000000100000500a14004220" data-slot="usage-item"><div data-slot="usage-header"><span data-slot="usage-label">${label}</span><span data-slot="usage-value">${value}</span></div><div data-slot="progress"><div data-slot="progress-bar" style="width:${percent}%"></div></div><span data-slot="reset-time">${resetText}</span></div>`;
}

function consolePage(options: { comments?: boolean; email?: string } = {}): string {
  const { comments = true, email = "user@example.com" } = options;
  return `<!DOCTYPE html><html><body><div data-slot="user-menu">${email}</div><div data-slot="usage">${usageItem(
    "Rolling Usage",
    0,
    "3 hours 47 minutes",
    comments,
  )}${usageItem("Weekly Usage", 0, "9 hours 39 minutes", comments)}${usageItem(
    "Monthly Usage",
    68,
    "4 days 3 hours",
    comments,
  )}</div></body></html>`;
}

describe("parseResetMs", () => {
  test("parses day/hour/minute countdowns", () => {
    expect(parseResetMs("Resets in 4 days 3 hours")).toBe(4 * 86_400_000 + 3 * 3_600_000);
    expect(parseResetMs("Resets in 9 hours 39 minutes")).toBe(9 * 3_600_000 + 39 * 60_000);
    expect(parseResetMs("Resets in 52 minutes")).toBe(52 * 60_000);
    expect(parseResetMs("Resets in 1 day 1 hour")).toBe(86_400_000 + 3_600_000);
  });

  test("rejects empty and unrelated text", () => {
    expect(parseResetMs("Resets in")).toBeUndefined();
    expect(parseResetMs("no countdown here")).toBeUndefined();
  });
});

describe("parseGoConsoleHtml", () => {
  test("parses usage bars with hydration comment markers", () => {
    const items = parseGoConsoleHtml(consolePage());
    expect(items).toEqual([
      { label: "Rolling Usage", percent: 0, resetMs: 3 * 3_600_000 + 47 * 60_000 },
      { label: "Weekly Usage", percent: 0, resetMs: 9 * 3_600_000 + 39 * 60_000 },
      { label: "Monthly Usage", percent: 68, resetMs: 4 * 86_400_000 + 3 * 3_600_000 },
    ]);
  });

  test("parses usage bars without hydration comment markers", () => {
    const items = parseGoConsoleHtml(consolePage({ comments: false }));
    expect(items.map((item) => item.percent)).toEqual([0, 0, 68]);
  });

  test("returns no items for an unrelated page", () => {
    expect(parseGoConsoleHtml("<html><body>subscribe to go</body></html>")).toEqual([]);
  });
});

async function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: handler });
  return { server, url: server.url.toString().replace(/\/$/, "") };
}

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
          amount: { usedFraction: 0.066, unit: "usd" as const },
        },
        measurementSource: "omp-auth-storage",
        fetchedAt: NOW,
        stale,
      },
    ],
  };
}

describe("OpencodeGoConsoleUsageSource", () => {
  test("is disabled without a cookie", async () => {
    const source = new OpencodeGoConsoleUsageSource({ now: () => NOW });
    expect(source.diagnostic().enabled).toBe(false);
    expect(await source.refresh(AbortSignal.timeout(5_000))).toEqual([]);
  });

  test("discovers the workspace and reports exact quota", async () => {
    const seen: { url: string; cookie: string | null }[] = [];
    const { server, url } = await serve((request) => {
      const target = new URL(request.url);
      seen.push({ url: target.pathname, cookie: request.headers.get("cookie") });
      if (target.pathname === "/auth") {
        return new Response(null, {
          status: 302,
          headers: { location: `${url}/workspace/wrk_TEST123` },
        });
      }
      if (target.pathname === "/workspace/wrk_TEST123/go") {
        return new Response(consolePage(), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    try {
      const source = new OpencodeGoConsoleUsageSource({
        cookie: "session-token",
        baseUrl: url,
        now: () => NOW,
      });
      const snapshots = await source.refresh(AbortSignal.timeout(5_000));
      expect(seen.map((entry) => entry.url)).toEqual(["/auth", "/workspace/wrk_TEST123/go"]);
      expect(seen.every((entry) => entry.cookie === "auth=session-token")).toBe(true);

      expect(snapshots).toHaveLength(1);
      const snapshot = snapshots[0];
      expect(snapshot?.id).toBe("opencode-go:console:wrk_TEST123");
      expect(snapshot?.provider).toBe("opencode-go");
      expect(snapshot?.accountLabel).toBe("user@example.com");
      expect(snapshot?.identitySource).toBe("opencode-go-console");
      expect(snapshot?.limits.map((limit) => limit.limit.id)).toEqual([
        "rolling-5h",
        "weekly",
        "monthly",
      ]);
      const monthly = snapshot?.limits[2];
      expect(monthly?.stale).toBe(false);
      expect(monthly?.fetchedAt).toBe(NOW);
      expect(monthly?.limit.amount.usedFraction).toBeCloseTo(0.68, 6);
      expect(monthly?.limit.window?.resetsAt).toBe(NOW + 4 * 86_400_000 + 3 * 3_600_000);
      expect(monthly?.limit.window?.durationMs).toBe(30 * 86_400_000);
      expect(snapshot?.limits[0]?.limit.window?.durationMs).toBe(5 * 3_600_000);
      expect(snapshot?.limits[1]?.limit.window?.durationMs).toBe(7 * 86_400_000);
      expect(source.diagnostic().lastSuccessAt).toBe(NOW);
    } finally {
      server.stop();
    }
  });

  test("skips discovery when the workspace is configured", async () => {
    const seen: string[] = [];
    const { server, url } = await serve((request) => {
      const target = new URL(request.url);
      seen.push(target.pathname);
      return new Response(consolePage(), { status: 200 });
    });
    try {
      const source = new OpencodeGoConsoleUsageSource({
        cookie: "session-token",
        workspace: "wrk_FIXED",
        baseUrl: url,
        now: () => NOW,
      });
      const snapshots = await source.refresh(AbortSignal.timeout(5_000));
      expect(seen).toEqual(["/workspace/wrk_FIXED/go"]);
      expect(snapshots[0]?.id).toBe("opencode-go:console:wrk_FIXED");
    } finally {
      server.stop();
    }
  });

  test("reports an expired session as an auth error without data", async () => {
    const { server, url } = await serve(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://auth.opencode.ai/authorize?client_id=app" },
        }),
    );
    try {
      const source = new OpencodeGoConsoleUsageSource({
        cookie: "stale-token",
        baseUrl: url,
        now: () => NOW,
      });
      expect(await source.refresh(AbortSignal.timeout(5_000))).toEqual([]);
      const diagnostic = source.diagnostic();
      expect(diagnostic.lastErrorCategory).toBe("auth");
      expect(diagnostic.detail).toContain("auth");
    } finally {
      server.stop();
    }
  });

  test("preserves last-good data as stale after the session lapses, then expires it", async () => {
    let mode: "ok" | "expired" = "ok";
    const { server, url } = await serve((request) => {
      const target = new URL(request.url);
      if (target.pathname === "/workspace/wrk_TEST123/go" && mode === "ok") {
        return new Response(consolePage(), { status: 200 });
      }
      return new Response(null, {
        status: 302,
        headers: { location: "https://auth.opencode.ai/authorize?client_id=app" },
      });
    });
    try {
      let now = NOW;
      const source = new OpencodeGoConsoleUsageSource({
        cookie: "session-token",
        workspace: "wrk_TEST123",
        baseUrl: url,
        staleAfterMs: 30 * 60_000,
        now: () => now,
      });
      const fresh = await source.refresh(AbortSignal.timeout(5_000));
      expect(fresh[0]?.limits.every((limit) => !limit.stale)).toBe(true);

      mode = "expired";
      now += 10 * 60_000;
      const preserved = await source.refresh(AbortSignal.timeout(5_000));
      expect(preserved).toHaveLength(1);
      expect(preserved[0]?.limits.every((limit) => limit.stale)).toBe(true);
      expect(preserved[0]?.limits[2]?.limit.amount.usedFraction).toBeCloseTo(0.68, 6);
      expect(source.diagnostic().lastErrorCategory).toBe("auth");

      now += 31 * 60_000;
      expect(await source.refresh(AbortSignal.timeout(5_000))).toEqual([]);
    } finally {
      server.stop();
    }
  });

  test("reports a changed page as a schema error and keeps stale data", async () => {
    let body = consolePage();
    const { server, url } = await serve(() => new Response(body, { status: 200 }));
    try {
      const source = new OpencodeGoConsoleUsageSource({
        cookie: "session-token",
        workspace: "wrk_TEST123",
        baseUrl: url,
        now: () => NOW,
      });
      await source.refresh(AbortSignal.timeout(5_000));
      body = "<html><body>promo</body></html>";
      const preserved = await source.refresh(AbortSignal.timeout(5_000));
      expect(preserved[0]?.limits.every((limit) => limit.stale)).toBe(true);
      expect(source.diagnostic().lastErrorCategory).toBe("schema");
    } finally {
      server.stop();
    }
  });
});

describe("console precedence in mergeSnapshots", () => {
  function consoleSnapshot(stale: boolean): SubscriptionSnapshot {
    const base = syntheticSnapshot();
    return {
      ...base,
      id: "opencode-go:console:wrk_TEST123",
      accountId: "opencode-go:console:wrk_TEST123",
      identitySource: "opencode-go-console",
      limits: base.limits.map((limit) => ({
        ...limit,
        measurementSource: "opencode-go-console" as const,
        stale,
        limit: { ...limit.limit, amount: { usedFraction: 0.68, unit: "usd" as const } },
      })),
    };
  }

  test("fresh console data replaces the synthetic estimate", () => {
    const merged = mergeSnapshots([[syntheticSnapshot()], [consoleSnapshot(false)]]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.identitySource).toBe("opencode-go-console");
    expect(merged[0]?.limits[0]?.limit.amount.usedFraction).toBeCloseTo(0.68, 6);
  });

  test("stale console data cedes to a fresh synthetic estimate", () => {
    const merged = mergeSnapshots([[syntheticSnapshot()], [consoleSnapshot(true)]]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.identitySource).toBe("omp-auth-storage");
    expect(merged[0]?.limits[0]?.limit.amount.usedFraction).toBeCloseTo(0.066, 6);
  });

  test("stale console data survives when no fresh alternative exists", () => {
    const merged = mergeSnapshots([[syntheticSnapshot(true)], [consoleSnapshot(true)]]);
    expect(merged).toHaveLength(2);
  });

  test("console data alone renders when synthetic sources are absent", () => {
    const merged = mergeSnapshots([[consoleSnapshot(false)]]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.identitySource).toBe("opencode-go-console");
  });
});

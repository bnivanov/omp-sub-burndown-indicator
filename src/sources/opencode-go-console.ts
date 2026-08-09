import type { UsageLimit } from "@oh-my-pi/pi-ai";
import type { BurndownConfig } from "../config.ts";
import type { LimitObservation, SourceDiagnostic, SubscriptionSnapshot } from "../domain/types.ts";
import { type UsageSource, UsageSourceError } from "./source.ts";

/**
 * Exact OpenCode Go quota read from the opencode.ai console.
 *
 * The Go model gateway (`/zen/go/v1/*`) authenticates and enforces the
 * rolling/weekly/monthly limits but never reports them: no usage endpoint, no
 * rate-limit headers. The only place the server-side counters surface is the
 * console page `https://opencode.ai/workspace/<id>/go`, which is
 * server-rendered — a plain authenticated GET returns the three usage bars.
 *
 * This source is explicit opt-in: it activates only when the user supplies
 * their console `auth` session cookie. When enabled and healthy, the
 * coordinator prefers these exact observations over OMP's synthetic
 * `omp-observed-request-costs` estimate for opencode-go; when the session
 * lapses or the fetch fails, preserved data decays to stale and the synthetic
 * estimate takes over again.
 */

const PROVIDER = "opencode-go";
const DEFAULT_BASE_URL = "https://opencode.ai";
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

interface ConsoleWindow {
  key: string;
  limitId: string;
  label: string;
  durationMs: number;
  limitUsd: number;
}

/** Mirrors the documented Go limits and pi-ai's synthetic window identity. */
const CONSOLE_WINDOWS: readonly ConsoleWindow[] = [
  { key: "rolling", limitId: "rolling-5h", label: "5 Hour", durationMs: 5 * HOUR_MS, limitUsd: 12 },
  { key: "weekly", limitId: "weekly", label: "Weekly", durationMs: 7 * DAY_MS, limitUsd: 30 },
  { key: "monthly", limitId: "monthly", label: "Monthly", durationMs: 30 * DAY_MS, limitUsd: 60 },
];

export interface OpencodeGoConsoleUsageSourceOptions {
  cookie?: string;
  /** Workspace id (`wrk_…`); when omitted, discovered via the /auth redirect. */
  workspace?: string;
  /** Override for tests; defaults to https://opencode.ai. */
  baseUrl?: string;
  /** Override for tests. */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  staleAfterMs?: number;
  now?: () => number;
}

type SourceConfig = Pick<BurndownConfig, "opencodeGoConsole" | "timeoutMs" | "staleAfterMs">;

interface ParsedUsageItem {
  label: string;
  percent: number;
  resetMs?: number;
}

/** English reset countdowns: "4 days 3 hours", "9 hours 39 minutes", "52 minutes". */
export function parseResetMs(text: string): number | undefined {
  const match =
    /resets in\s+(?:(\d+)\s+days?)?\s*(?:(\d+)\s+hours?)?\s*(?:(\d+)\s+minutes?)?\s*(?:(\d+)\s+seconds?)?/i.exec(
      text,
    );
  if (!match) return undefined;
  const days = match[1] === undefined ? 0 : Number(match[1]);
  const hours = match[2] === undefined ? 0 : Number(match[2]);
  const minutes = match[3] === undefined ? 0 : Number(match[3]);
  const seconds = match[4] === undefined ? 0 : Number(match[4]);
  const totalMs = days * DAY_MS + hours * HOUR_MS + minutes * 60_000 + seconds * 1_000;
  return totalMs > 0 ? totalMs : undefined;
}

const USAGE_ITEM_PATTERN = /data-slot="usage-item"[\s\S]*?(?=data-slot="usage-item"|$)/g;
const LABEL_PATTERN = /data-slot="usage-label">\s*([^<]+?)\s*<\/span>/;
const VALUE_PATTERN = /data-slot="usage-value">\s*(\d{1,3})\s*%\s*<\/span>/;
const RESET_PATTERN = /data-slot="reset-time">([\s\S]*?)<\/span>/;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * Parse the SSR usage bars. Returns items in render order (rolling, weekly,
 * monthly); English labels are recognized when present but are not required —
 * the console renders the three bars in a fixed order in every locale.
 */
export function parseGoConsoleHtml(html: string): ParsedUsageItem[] {
  // Strip Solid hydration comment markers (`<!--$-->` / `<!--/-->`).
  const clean = html.replace(/<!--\$-->|<!--\/|-->/g, "");
  const items: ParsedUsageItem[] = [];
  for (const block of clean.matchAll(USAGE_ITEM_PATTERN)) {
    const text = block[0];
    const value = VALUE_PATTERN.exec(text);
    if (!value) continue;
    const label = LABEL_PATTERN.exec(text)?.[1] ?? "";
    const resetText = RESET_PATTERN.exec(text)?.[1];
    const resetMs = resetText ? parseResetMs(resetText) : undefined;
    items.push({
      label,
      percent: Number(value[1]),
      ...(resetMs !== undefined ? { resetMs } : {}),
    });
  }
  return items;
}

function windowForItem(item: ParsedUsageItem, index: number): ConsoleWindow | undefined {
  const normalized = item.label.toLocaleLowerCase();
  const byLabel = CONSOLE_WINDOWS.find((entry) => normalized.startsWith(entry.key));
  return byLabel ?? CONSOLE_WINDOWS[index];
}

function resolveStatus(usedFraction: number): NonNullable<UsageLimit["status"]> {
  if (usedFraction >= 1) return "exhausted";
  if (usedFraction >= 0.8) return "warning";
  return "ok";
}

function buildLimit(window: ConsoleWindow, item: ParsedUsageItem, now: number): UsageLimit {
  const usedFraction = item.percent / 100;
  const used = Number((usedFraction * window.limitUsd).toFixed(6));
  return {
    id: window.limitId,
    label: `${window.label} limit`,
    scope: { provider: PROVIDER, windowId: window.limitId },
    window: {
      id: window.limitId,
      label: window.label,
      durationMs: window.durationMs,
      ...(item.resetMs !== undefined ? { resetsAt: now + item.resetMs } : {}),
    },
    amount: {
      used,
      limit: window.limitUsd,
      remaining: Math.max(0, window.limitUsd - used),
      usedFraction,
      remainingFraction: Math.max(0, 1 - usedFraction),
      unit: "usd",
    },
    status: resolveStatus(usedFraction),
  };
}

function classifyStatus(status: number): UsageSourceError["category"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "server";
  return "network";
}

export class OpencodeGoConsoleUsageSource implements UsageSource {
  readonly id = "opencode-go-console" as const;
  readonly #cookie: string | undefined;
  readonly #workspaceOverride: string | undefined;
  readonly #baseUrl: string;
  readonly #fetchFn: typeof fetch;
  readonly #timeoutMs: number;
  readonly #staleAfterMs: number;
  readonly #now: () => number;
  #workspace: string | undefined;
  #lastGood: SubscriptionSnapshot[] = [];
  #inFlight: Promise<SubscriptionSnapshot[]> | undefined;
  #lastSuccessAt: number | undefined;
  #lastErrorAt: number | undefined;
  #lastErrorCategory: UsageSourceError["category"] | undefined;

  constructor(
    config: SourceConfig | OpencodeGoConsoleUsageSourceOptions,
    options: OpencodeGoConsoleUsageSourceOptions = {},
  ) {
    const candidate = config as SourceConfig & OpencodeGoConsoleUsageSourceOptions;
    const direct = candidate.opencodeGoConsole;
    this.#cookie = options.cookie ?? candidate.cookie ?? direct?.cookie;
    this.#workspaceOverride = options.workspace ?? candidate.workspace ?? direct?.workspace;
    this.#baseUrl = (options.baseUrl ?? candidate.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#fetchFn = options.fetchFn ?? candidate.fetchFn ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? candidate.timeoutMs ?? 15_000;
    this.#staleAfterMs = options.staleAfterMs ?? candidate.staleAfterMs ?? 1_800_000;
    this.#now = options.now ?? candidate.now ?? (() => Date.now());
    this.#workspace = this.#workspaceOverride;
  }

  get enabled(): boolean {
    return this.#cookie !== undefined && this.#cookie.length > 0;
  }

  refresh(signal: AbortSignal): Promise<SubscriptionSnapshot[]> {
    if (!this.enabled) return Promise.resolve([]);
    if (this.#inFlight) return this.#inFlight;
    const request = this.#runRefresh(signal).finally(() => {
      if (this.#inFlight === request) this.#inFlight = undefined;
    });
    this.#inFlight = request;
    return request;
  }

  diagnostic(): SourceDiagnostic {
    const diagnostic: SourceDiagnostic = { sourceId: this.id, enabled: this.enabled };
    if (this.#lastSuccessAt !== undefined) diagnostic.lastSuccessAt = this.#lastSuccessAt;
    if (this.#lastErrorAt !== undefined) diagnostic.lastErrorAt = this.#lastErrorAt;
    if (this.#lastErrorCategory !== undefined) {
      diagnostic.lastErrorCategory = this.#lastErrorCategory;
      diagnostic.detail = `OpenCode Go console refresh failed (${this.#lastErrorCategory})`;
    }
    return diagnostic;
  }

  async #runRefresh(callerSignal: AbortSignal): Promise<SubscriptionSnapshot[]> {
    const timeoutController = new AbortController();
    const timer = setTimeout(
      () => timeoutController.abort(new DOMException("Timeout", "TimeoutError")),
      this.#timeoutMs,
    );
    const signal = AbortSignal.any([callerSignal, timeoutController.signal]);
    try {
      if (callerSignal.aborted) {
        throw new UsageSourceError("aborted", "OpenCode Go console refresh aborted");
      }
      const workspace = await this.#resolveWorkspace(signal);
      const html = await this.#fetchUsagePage(workspace, signal);
      const snapshots = this.#parse(html, workspace);
      this.#lastGood = snapshots;
      this.#lastSuccessAt = this.#now();
      this.#lastErrorAt = undefined;
      this.#lastErrorCategory = undefined;
      return snapshots;
    } catch (error) {
      const usageError = this.#toUsageError(error, callerSignal, timeoutController.signal);
      this.#lastErrorAt = this.#now();
      this.#lastErrorCategory = usageError.category;
      if (usageError.category === "aborted") throw usageError;
      // Every failure cedes to the synthetic estimate once preserved data
      // decays to stale; never fail the refresh cycle for this probe.
      return this.#preservedSnapshots();
    } finally {
      clearTimeout(timer);
    }
  }

  async #get(url: string, signal: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetchFn(url, {
        redirect: "manual",
        signal,
        headers: {
          accept: "text/html",
          cookie: `auth=${this.#cookie}`,
        },
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") throw error;
      if (signal.aborted) throw signal.reason ?? error;
      throw new UsageSourceError(
        "network",
        `OpenCode Go console request failed: ${error instanceof Error ? error.message : error}`,
      );
    }
    return response;
  }

  async #resolveWorkspace(signal: AbortSignal): Promise<string> {
    if (this.#workspace) return this.#workspace;
    const response = await this.#get(`${this.#baseUrl}/auth`, signal);
    const location = response.headers.get("location") ?? "";
    if (location.includes("auth.opencode.ai") || location.includes("/authorize")) {
      throw new UsageSourceError("auth", "OpenCode Go console session expired or invalid");
    }
    const workspace = /\/workspace\/(wrk_[A-Za-z0-9]+)/.exec(location)?.[1];
    if (!workspace) {
      throw new UsageSourceError(
        "schema",
        `OpenCode Go console workspace discovery failed (status ${response.status})`,
      );
    }
    this.#workspace = workspace;
    return workspace;
  }

  async #fetchUsagePage(workspace: string, signal: AbortSignal): Promise<string> {
    const response = await this.#get(`${this.#baseUrl}/workspace/${workspace}/go`, signal);
    if (response.status === 200) return response.text();
    const location = response.headers.get("location") ?? "";
    if (location.includes("auth.opencode.ai") || location.includes("/authorize")) {
      this.#workspace = this.#workspaceOverride;
      throw new UsageSourceError("auth", "OpenCode Go console session expired or invalid");
    }
    if (response.status >= 300 && response.status < 400) {
      this.#workspace = this.#workspaceOverride;
      throw new UsageSourceError(
        "schema",
        `OpenCode Go console page redirected unexpectedly (status ${response.status})`,
      );
    }
    throw new UsageSourceError(
      classifyStatus(response.status),
      `OpenCode Go console page failed (status ${response.status})`,
    );
  }

  #parse(html: string, workspace: string): SubscriptionSnapshot[] {
    const items = parseGoConsoleHtml(html);
    if (items.length !== CONSOLE_WINDOWS.length) {
      throw new UsageSourceError(
        "schema",
        `OpenCode Go console parse failed (expected ${CONSOLE_WINDOWS.length} usage bars, got ${items.length}; page changed or no Go subscription?)`,
      );
    }
    const now = this.#now();
    const email = EMAIL_PATTERN.exec(html)?.[0];
    const limits: LimitObservation[] = items.map((item, index) => {
      const window = windowForItem(item, index);
      if (!window)
        throw new UsageSourceError("schema", "OpenCode Go console window mapping failed");
      return {
        limit: buildLimit(window, item, now),
        measurementSource: "opencode-go-console",
        fetchedAt: now,
        stale: false,
      };
    });
    const id = `opencode-go:console:${workspace}`;
    return [
      {
        id,
        provider: PROVIDER,
        accountId: id,
        ...(email ? { accountLabel: email } : {}),
        identitySource: "opencode-go-console",
        limits,
      },
    ];
  }

  #preservedSnapshots(): SubscriptionSnapshot[] {
    return this.#lastGood
      .map((snapshot) => {
        const limits = snapshot.limits
          .filter((item) => this.#isWithinAge(item.fetchedAt))
          .map((item) => ({ ...item, limit: structuredClone(item.limit), stale: true }));
        return limits.length > 0 ? { ...snapshot, limits } : undefined;
      })
      .filter((snapshot): snapshot is SubscriptionSnapshot => snapshot !== undefined);
  }

  #isWithinAge(fetchedAt: number): boolean {
    return this.#now() - fetchedAt <= this.#staleAfterMs;
  }

  #toUsageError(
    error: unknown,
    callerSignal: AbortSignal,
    timeoutSignal: AbortSignal,
  ): UsageSourceError {
    if (error instanceof UsageSourceError) return error;
    if (callerSignal.aborted)
      return new UsageSourceError("aborted", "OpenCode Go console refresh aborted");
    const category: UsageSourceError["category"] =
      timeoutSignal.aborted || (error instanceof DOMException && error.name === "TimeoutError")
        ? "timeout"
        : "network";
    return new UsageSourceError(
      category,
      `OpenCode Go console refresh failed (${category}): ${error instanceof Error ? error.message : error}`,
    );
  }
}

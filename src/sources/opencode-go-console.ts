import type { UsageLimit } from "@oh-my-pi/pi-ai";
import type { BurndownConfig } from "../config.ts";
import type { SourceDiagnostic, SubscriptionSnapshot } from "../domain/types.ts";
import { type UsageSource, UsageSourceError } from "./source.ts";

/**
 * Exact OpenCode Go quota read from OpenCode's bearer-authenticated usage API.
 *
 * The API reports the account's rolling, weekly, and monthly percentages and
 * reset anchors. This source is explicit opt-in: it activates only when the
 * user supplies the API key. When enabled and healthy, the coordinator
 * prefers these exact observations over OMP's synthetic
 * `omp-observed-request-costs` estimate for opencode-go; when the request fails,
 * preserved data decays to stale and the synthetic estimate takes over again.
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
  token?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  staleAfterMs?: number;
  now?: () => number;
}

type SourceConfig = Pick<BurndownConfig, "opencodeGoConsole" | "timeoutMs" | "staleAfterMs">;

interface ParsedUsageItem {
  status: string;
  percent: number;
  resetsAt: number;
}

export function parseGoConsoleUsage(value: unknown): ParsedUsageItem[] {
  if (typeof value !== "object" || value === null || !("usage" in value)) {
    throw new Error("missing usage");
  }
  const usage = value.usage;
  if (typeof usage !== "object" || usage === null) throw new Error("invalid usage");
  const usageRecord = Object.fromEntries(Object.entries(usage));
  return ["rolling", "weekly", "monthly"].map((key) => {
    if (!(key in usageRecord)) throw new Error(`missing ${key} usage`);
    const item = usageRecord[key];
    if (typeof item !== "object" || item === null) throw new Error(`invalid ${key} usage`);
    if (
      !("status" in item) ||
      typeof item.status !== "string" ||
      !("percent" in item) ||
      typeof item.percent !== "number" ||
      !Number.isFinite(item.percent) ||
      item.percent < 0 ||
      item.percent > 100 ||
      !("resetsAt" in item) ||
      typeof item.resetsAt !== "string"
    ) {
      throw new Error(`invalid ${key} usage`);
    }
    const resetsAt = Date.parse(item.resetsAt);
    if (!Number.isFinite(resetsAt)) throw new Error(`invalid ${key} reset`);
    return { status: item.status, percent: item.percent, resetsAt };
  });
}

function resolveStatus(item: ParsedUsageItem): NonNullable<UsageLimit["status"]> {
  if (item.status === "exhausted" || item.percent >= 100) return "exhausted";
  if (item.status === "warning" || item.percent >= 80) return "warning";
  return "ok";
}

function buildLimit(window: ConsoleWindow, item: ParsedUsageItem): UsageLimit {
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
      resetsAt: item.resetsAt,
    },
    amount: {
      used,
      limit: window.limitUsd,
      remaining: Math.max(0, window.limitUsd - used),
      usedFraction,
      remainingFraction: Math.max(0, 1 - usedFraction),
      unit: "usd",
    },
    status: resolveStatus(item),
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
  readonly #token: string | undefined;
  readonly #baseUrl: string;
  readonly #fetchFn: typeof fetch;
  readonly #timeoutMs: number;
  readonly #staleAfterMs: number;
  readonly #now: () => number;
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
    this.#token = options.token ?? candidate.token ?? direct?.token;
    this.#baseUrl = (options.baseUrl ?? candidate.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#fetchFn = options.fetchFn ?? candidate.fetchFn ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? candidate.timeoutMs ?? 15_000;
    this.#staleAfterMs = options.staleAfterMs ?? candidate.staleAfterMs ?? 1_800_000;
    this.#now = options.now ?? candidate.now ?? (() => Date.now());
  }

  get enabled(): boolean {
    return this.#token !== undefined && this.#token.length > 0;
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
      diagnostic.detail = `OpenCode Go usage API refresh failed (${this.#lastErrorCategory})`;
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
      if (callerSignal.aborted)
        throw new UsageSourceError("aborted", "OpenCode Go usage refresh aborted");
      const response = await this.#get(signal);
      if (response.status !== 200) {
        throw new UsageSourceError(
          classifyStatus(response.status),
          `OpenCode Go usage API failed (status ${response.status})`,
        );
      }
      const snapshots = this.#parse(await response.json());
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
      return this.#preservedSnapshots();
    } finally {
      clearTimeout(timer);
    }
  }

  async #get(signal: AbortSignal): Promise<Response> {
    try {
      return await this.#fetchFn(`${this.#baseUrl}/zen/go/v1/usage`, {
        signal,
        headers: { accept: "application/json", authorization: `Bearer ${this.#token}` },
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") throw error;
      if (signal.aborted) throw signal.reason ?? error;
      throw new UsageSourceError(
        "network",
        `OpenCode Go usage request failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  #parse(payload: unknown): SubscriptionSnapshot[] {
    const items = parseGoConsoleUsage(payload);
    const limits = items.map((item, index) => {
      const window = CONSOLE_WINDOWS[index];
      if (!window)
        throw new UsageSourceError("schema", `OpenCode Go usage window ${index} is missing`);
      return {
        limit: buildLimit(window, item),
        measurementSource: "opencode-go-console" as const,
        fetchedAt: this.#now(),
        stale: false,
      };
    });
    const id = "opencode-go:usage";
    return [
      { id, provider: PROVIDER, accountId: id, identitySource: "opencode-go-console", limits },
    ];
  }

  #preservedSnapshots(): SubscriptionSnapshot[] {
    return this.#lastGood
      .map((snapshot) => {
        const limits = snapshot.limits
          .filter((item) => this.#now() - item.fetchedAt <= this.#staleAfterMs)
          .map((item) => ({ ...item, limit: structuredClone(item.limit), stale: true }));
        return limits.length > 0 ? { ...snapshot, limits } : undefined;
      })
      .filter((snapshot): snapshot is SubscriptionSnapshot => snapshot !== undefined);
  }

  #toUsageError(
    error: unknown,
    callerSignal: AbortSignal,
    timeoutSignal: AbortSignal,
  ): UsageSourceError {
    if (error instanceof UsageSourceError) return error;
    if (callerSignal.aborted)
      return new UsageSourceError("aborted", "OpenCode Go usage refresh aborted");
    const category =
      timeoutSignal.aborted || (error instanceof DOMException && error.name === "TimeoutError")
        ? "timeout"
        : "schema";
    return new UsageSourceError(
      category,
      `OpenCode Go usage refresh failed (${category}): ${error instanceof Error ? error.message : error}`,
    );
  }
}

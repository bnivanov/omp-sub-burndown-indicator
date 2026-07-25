import type { UsageLimit } from "@oh-my-pi/pi-ai";

/** Semantic quota classes the indicator can target. */
export type WindowClass = "five_hour" | "week" | "month" | "other";

/** User-facing view mode for which class(es) to show. */
export type WindowViewMode = "five_hour" | "week" | "month" | "all";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

/** Nominal 5h window with a small reporting tolerance. */
const FIVE_HOUR_MS = 5 * HOUR_MS;
const FIVE_HOUR_MIN_MS = 4.5 * HOUR_MS;
const FIVE_HOUR_MAX_MS = 5.5 * HOUR_MS;

/** Nominal 7d / weekly window. */
const WEEK_MS = 7 * DAY_MS;
const WEEK_MIN_MS = 6 * DAY_MS;
const WEEK_MAX_MS = 8 * DAY_MS;

/** Nominal ~30d monthly window (providers vary 28–31d). */
const MONTH_MS = 30 * DAY_MS;
const MONTH_MIN_MS = 27 * DAY_MS;
const MONTH_MAX_MS = 32 * DAY_MS;

const VIEW_CYCLE: readonly WindowViewMode[] = ["five_hour", "week", "month", "all"];

function finitePositive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function sourceText(limit: UsageLimit): string {
  const window = limit.window;
  return [limit.id, limit.label, window?.id, window?.label, limit.scope.windowId]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ")
    .toLocaleLowerCase();
}

function classFromDuration(durationMs: number): WindowClass | undefined {
  if (durationMs >= FIVE_HOUR_MIN_MS && durationMs <= FIVE_HOUR_MAX_MS) return "five_hour";
  if (durationMs >= WEEK_MIN_MS && durationMs <= WEEK_MAX_MS) return "week";
  if (durationMs >= MONTH_MIN_MS && durationMs <= MONTH_MAX_MS) return "month";
  return undefined;
}

function classFromText(source: string): WindowClass | undefined {
  if (!source) return undefined;
  // Prefer longer/more specific tokens first so "rolling-5h" and "7d" win over bare "h"/"d".
  if (
    /\b5\s*h\b/.test(source) ||
    /\b5-?hour/.test(source) ||
    /\bfive[-\s]?hour/.test(source) ||
    /\brolling-5h\b/.test(source)
  ) {
    return "five_hour";
  }
  if (
    /\b7\s*d\b/.test(source) ||
    /\b7-?day/.test(source) ||
    /\bweek(?:ly)?\b/.test(source) ||
    /\bwk\b/.test(source)
  ) {
    return "week";
  }
  if (/\b30\s*d\b/.test(source) || /\bmonth(?:ly)?\b/.test(source) || /\bmo\b/.test(source)) {
    return "month";
  }
  return undefined;
}
/**
 * Classify a limit into an exact semantic window class.
 *
 * A finite positive duration is authoritative: only near-nominal 5h / 7d / 30d
 * values become those classes; any other positive duration is `other`, even if
 * the id/label says "5h". When duration is missing, use id/label tokens, then
 * stable provider-specific summary rules (never a moving reset-horizon guess).
 */
export function classifyWindow(limit: UsageLimit): WindowClass {
  const durationMs = limit.window?.durationMs;
  if (finitePositive(durationMs)) {
    return classFromDuration(durationMs) ?? "other";
  }
  return classFromText(sourceText(limit)) ?? classFromProviderSummary(limit) ?? "other";
}

/**
 * Kimi reports a durationless plan summary (`default` / "Usage window" /
 * "Total quota") alongside an explicit 5h row. That summary is the longer
 * weekly-style quota and must classify as week independently of how close
 * reset is.
 */
function classFromProviderSummary(limit: UsageLimit): WindowClass | undefined {
  const provider = `${limit.scope.provider ?? ""}`.trim().toLocaleLowerCase();
  if (provider !== "kimi-code" && provider !== "kimi") return undefined;
  const windowId = `${limit.window?.id ?? limit.scope.windowId ?? ""}`.trim().toLocaleLowerCase();
  const labels = `${limit.label ?? ""} ${limit.window?.label ?? ""}`.trim().toLocaleLowerCase();
  const isDefaultWindow = windowId === "" || windowId === "default";
  const isSummaryLabel =
    labels.length === 0 ||
    labels.includes("usage window") ||
    labels.includes("total quota") ||
    labels.includes("plan") ||
    labels.includes("summary");
  if (isDefaultWindow && isSummaryLabel) return "week";
  return undefined;
}

/** Compact label for a classified window; `other` uses real duration, never 5h/Wk/Mo. */
export function windowClassLabel(
  windowClass: WindowClass,
  durationMs: number | undefined,
): string | undefined {
  if (windowClass === "five_hour") return "5h";
  if (windowClass === "week") return "Wk";
  if (windowClass === "month") return "Mo";
  return otherDurationLabel(durationMs);
}

/** Human duration tag for non-semantic windows (1h, 1d, 14d, …). */
function otherDurationLabel(durationMs: number | undefined): string | undefined {
  if (!finitePositive(durationMs)) return undefined;
  if (durationMs < HOUR_MS) {
    const minutes = Math.max(1, Math.round(durationMs / 60_000));
    return `${minutes}m`;
  }
  if (durationMs < DAY_MS) {
    const hours = Math.max(1, Math.round(durationMs / HOUR_MS));
    return `${hours}h`;
  }
  const days = Math.max(1, Math.round(durationMs / DAY_MS));
  return `${days}d`;
}

export function isWindowViewMode(value: unknown): value is WindowViewMode {
  return value === "five_hour" || value === "week" || value === "month" || value === "all";
}

/** Parse slash-command / config tokens into a view mode. */
export function parseWindowViewMode(raw: string | undefined): WindowViewMode | undefined {
  if (raw === undefined) return undefined;
  const token = raw.trim().toLocaleLowerCase();
  if (!token) return undefined;
  // User-facing primary token is "hour"; 5h/five_hour remain aliases.
  if (
    token === "hour" ||
    token === "hours" ||
    token === "5h" ||
    token === "five_hour" ||
    token === "five-hour" ||
    token === "short" ||
    token === "hourly"
  ) {
    return "five_hour";
  }
  if (token === "week" || token === "weekly" || token === "wk" || token === "7d") {
    return "week";
  }
  if (token === "month" || token === "monthly" || token === "mo" || token === "30d") {
    return "month";
  }
  if (token === "all" || token === "both" || token === "every") {
    return "all";
  }
  return undefined;
}

export function nextWindowViewMode(current: WindowViewMode): WindowViewMode {
  const index = VIEW_CYCLE.indexOf(current);
  return VIEW_CYCLE[(index + 1) % VIEW_CYCLE.length] ?? "five_hour";
}

/** User-facing names: hour → week → month → all. */
export function describeWindowViewMode(mode: WindowViewMode): string {
  if (mode === "five_hour") return "hour";
  if (mode === "week") return "week";
  if (mode === "month") return "month";
  return "all (hour + week + month)";
}

/**
 * Nominal duration used only for pace when the provider omitted durationMs but
 * the limit is already a stable semantic class (e.g. Kimi week summary).
 * Never invents 5h from a short remaining reset alone.
 */
export function effectiveWindowDurationMs(
  windowClass: WindowClass,
  durationMs: number | undefined,
): number | undefined {
  if (finitePositive(durationMs)) return durationMs;
  if (windowClass === "five_hour") return FIVE_HOUR_MS;
  if (windowClass === "week") return WEEK_MS;
  if (windowClass === "month") return MONTH_MS;
  return undefined;
}

export const WINDOW_VIEW_COMMAND_TOKENS = ["hour", "week", "month", "all", "status"] as const;

/** Preferred single-class fallback order when the requested class is absent. */
export function fallbackClassOrder(preferred: Exclude<WindowViewMode, "all">): WindowClass[] {
  if (preferred === "five_hour") return ["five_hour", "week", "month", "other"];
  if (preferred === "week") return ["week", "five_hour", "month", "other"];
  return ["month", "week", "five_hour", "other"];
}

/** Classes emitted for a view when each is present on the subscription. */
export function viewClasses(mode: WindowViewMode): readonly WindowClass[] {
  if (mode === "all") return ["five_hour", "week", "month"];
  return [mode];
}

export const WINDOW_MS = {
  hour: HOUR_MS,
  day: DAY_MS,
  fiveHour: FIVE_HOUR_MS,
  week: WEEK_MS,
  month: MONTH_MS,
} as const;

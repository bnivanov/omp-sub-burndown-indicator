import { resolveUsedFraction, type UsageLimit } from "@oh-my-pi/pi-ai";
import type { BurndownSegment, LimitObservation, SubscriptionSnapshot } from "./types.ts";
import {
  classifyWindow,
  effectiveWindowDurationMs,
  fallbackClassOrder,
  viewClasses,
  type WindowClass,
  type WindowViewMode,
  windowClassLabel,
} from "./window-class.ts";

export interface BurndownOptions {
  now?: number;
  /** Pace tolerance as a fraction (0.01 means one percentage point). */
  paceTolerance?: number;
  /** Permit a reset timestamp this far in the past for clock skew. */
  clockSkewMs?: number;
  /** Maximum age before a measurement expires to unknown. */
  staleAfterMs?: number;
  /**
   * Which semantic window class(es) to surface.
   * Default `five_hour` prefers the 5h window and falls back when absent.
   */
  windowView?: WindowViewMode;
}

export interface EligibleWindow {
  observation: LimitObservation;
  usedFraction: number;
  windowClass: WindowClass;
}

const DEFAULT_TOLERANCE = 0.01;
const DEFAULT_CLOCK_SKEW_MS = 30_000;
const DEFAULT_WINDOW_VIEW: WindowViewMode = "five_hour";

function finiteNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function nowValue(options: BurndownOptions): number {
  return options.now ?? Date.now();
}

function hasPositiveDuration(limit: UsageLimit): boolean {
  const durationMs = limit.window?.durationMs;
  return finiteNumber(durationMs) && durationMs > 0;
}

/**
 * Selectable when usage is known and either:
 * - a positive duration exists (pace may still be unknown without reset), or
 * - a live reset exists and the limit classifies as a semantic window
 *   (durationless Kimi week / Copilot month).
 * Bare durationless `other` rows stay out.
 */
function isSelectableLimit(
  limit: UsageLimit,
  usedFraction: number,
  now: number,
  skew: number,
): boolean {
  if (!finiteNumber(usedFraction)) return false;
  const resetsAt = limit.window?.resetsAt;
  const hasLiveReset = finiteNumber(resetsAt) && resetsAt >= now - skew;
  if (finiteNumber(resetsAt) && !hasLiveReset) return false;
  if (hasPositiveDuration(limit)) return true;
  if (!hasLiveReset) return false;
  return classifyWindow(limit) !== "other";
}

function elapsedFractionAt(now: number, resetsAt: number, durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.min(1, Math.max(0, (now - (resetsAt - durationMs)) / durationMs));
}

function compareEligibleWindows(left: EligibleWindow, right: EligibleWindow, now: number): number {
  const leftWindow = left.observation.limit.window;
  const rightWindow = right.observation.limit.window;
  const leftDuration = leftWindow?.durationMs ?? Number.POSITIVE_INFINITY;
  const rightDuration = rightWindow?.durationMs ?? Number.POSITIVE_INFINITY;
  const leftReset = leftWindow?.resetsAt ?? Number.POSITIVE_INFINITY;
  const rightReset = rightWindow?.resetsAt ?? Number.POSITIVE_INFINITY;
  if (leftWindow?.id !== undefined && leftWindow.id === rightWindow?.id) {
    const leftUrgency = elapsedFractionAt(now, leftReset, leftDuration) - left.usedFraction;
    const rightUrgency = elapsedFractionAt(now, rightReset, rightDuration) - right.usedFraction;
    if (leftUrgency !== rightUrgency) return leftUrgency - rightUrgency;
  }
  if (leftDuration !== rightDuration) return leftDuration - rightDuration;
  if (leftReset !== rightReset) return leftReset - rightReset;
  return left.observation.limit.id.localeCompare(right.observation.limit.id);
}

/** Return windows that can participate in deterministic window selection. */
export function eligibleBurndownWindows(
  snapshot: SubscriptionSnapshot,
  now = Date.now(),
  clockSkewMs = DEFAULT_CLOCK_SKEW_MS,
): EligibleWindow[] {
  const skew =
    Number.isFinite(clockSkewMs) && clockSkewMs >= 0 ? clockSkewMs : DEFAULT_CLOCK_SKEW_MS;
  const result: EligibleWindow[] = [];
  for (const observation of snapshot.limits) {
    const limit = observation.limit;
    const usedFraction = resolveUsedFraction(limit);
    if (!finiteNumber(usedFraction) || !isSelectableLimit(limit, usedFraction, now, skew)) continue;
    result.push({
      observation,
      usedFraction,
      windowClass: classifyWindow(limit),
    });
  }
  return result;
}

/** Select the best eligible window across all classes. */
export function selectBurndownWindow(
  snapshot: SubscriptionSnapshot,
  now = Date.now(),
  clockSkewMs = DEFAULT_CLOCK_SKEW_MS,
): EligibleWindow | undefined {
  const eligible = eligibleBurndownWindows(snapshot, now, clockSkewMs);
  eligible.sort((left, right) => compareEligibleWindows(left, right, now));
  return eligible[0];
}

/** Select the shortest positive window across all classes (legacy default path). */
export function selectShortestBurndownWindow(
  snapshot: SubscriptionSnapshot,
  now = Date.now(),
  clockSkewMs = DEFAULT_CLOCK_SKEW_MS,
): EligibleWindow | undefined {
  return selectBurndownWindow(snapshot, now, clockSkewMs);
}

function otherWindowKey(entry: EligibleWindow): string {
  const limit = entry.observation.limit;
  const windowId = limit.window?.id || limit.scope.windowId || limit.id;
  const durationMs = limit.window?.durationMs;
  if (finiteNumber(durationMs) && durationMs > 0) return `${windowId}\0duration:${durationMs}`;
  const label = (limit.window?.label || limit.label || "").trim().toLocaleLowerCase();
  if (label) return `${windowId}\0label:${label}`;
  return `id:${windowId}`;
}

/**
 * Choose the eligible windows to display for a view mode.
 * Single-class modes fall back through a fixed order when the preferred class is absent.
 * `all` emits every present semantic class (5h, week, month) plus one entry per
 * distinct non-semantic (other) nominal window, labeled with real duration tags.
 */
export function selectWindowsForView(
  snapshot: SubscriptionSnapshot,
  windowView: WindowViewMode = DEFAULT_WINDOW_VIEW,
  now = Date.now(),
  clockSkewMs = DEFAULT_CLOCK_SKEW_MS,
): EligibleWindow[] {
  const eligible = eligibleBurndownWindows(snapshot, now, clockSkewMs);
  if (eligible.length === 0) return [];

  const bestByClass = new Map<WindowClass, EligibleWindow>();
  const bestOtherByKey = new Map<string, EligibleWindow>();
  for (const entry of eligible) {
    if (entry.windowClass === "other") {
      const key = otherWindowKey(entry);
      const previous = bestOtherByKey.get(key);
      if (!previous || compareEligibleWindows(entry, previous, now) < 0) {
        bestOtherByKey.set(key, entry);
      }
      continue;
    }
    const previous = bestByClass.get(entry.windowClass);
    if (!previous || compareEligibleWindows(entry, previous, now) < 0) {
      bestByClass.set(entry.windowClass, entry);
    }
  }

  if (windowView === "all") {
    const selected: EligibleWindow[] = [];
    for (const windowClass of viewClasses("all")) {
      const match = bestByClass.get(windowClass);
      if (match) selected.push(match);
    }
    const others = [...bestOtherByKey.values()].sort((left, right) =>
      compareEligibleWindows(left, right, now),
    );
    selected.push(...others);
    return selected;
  }

  for (const windowClass of fallbackClassOrder(windowView)) {
    if (windowClass === "other") {
      const others = [...bestOtherByKey.values()].sort((left, right) =>
        compareEligibleWindows(left, right, now),
      );
      if (others[0]) return [others[0]];
      continue;
    }
    const match = bestByClass.get(windowClass);
    if (match) return [match];
  }
  return [];
}

function staleExpired(
  observation: LimitObservation,
  now: number,
  staleAfterMs: number | undefined,
): boolean {
  if (!finiteNumber(observation.fetchedAt) || !finiteNumber(staleAfterMs)) return false;
  return now - observation.fetchedAt > staleAfterMs;
}

function segmentFromSelection(
  snapshot: SubscriptionSnapshot,
  selected: EligibleWindow | undefined,
  options: BurndownOptions,
  now: number,
  tolerance: number,
): BurndownSegment {
  const base = {
    subscriptionId: snapshot.id,
    provider: snapshot.provider,
    accountId: snapshot.accountId ?? snapshot.id,
    ...(snapshot.tier !== undefined ? { tier: snapshot.tier } : {}),
    label: snapshot.accountLabel ?? snapshot.provider,
  };

  if (!selected) {
    return { ...base, state: "unknown", stale: false };
  }

  const { observation, usedFraction, windowClass } = selected;
  const window = observation.limit.window;
  const resetsAt = window?.resetsAt;
  const reportedDurationMs = window?.durationMs;
  const durationMs = effectiveWindowDurationMs(windowClass, reportedDurationMs);
  const windowId = window?.id || observation.limit.scope.windowId || undefined;
  const label = windowClassLabel(windowClass, reportedDurationMs);
  const stale = observation.stale || staleExpired(observation, now, options.staleAfterMs);
  const metadata = {
    ...(windowId ? { windowId } : {}),
    windowClass,
    ...(label ? { windowLabel: label } : {}),
    ...(finiteNumber(resetsAt) ? { resetsAt } : {}),
    usedFraction,
  };

  if (
    stale &&
    options.staleAfterMs !== undefined &&
    staleExpired(observation, now, options.staleAfterMs)
  ) {
    return { ...base, ...metadata, state: "unknown", stale: true };
  }

  if (usedFraction >= 1) {
    return {
      ...base,
      ...metadata,
      ...(finiteNumber(durationMs) && finiteNumber(resetsAt)
        ? { elapsedFraction: elapsedFractionAt(now, resetsAt, durationMs) }
        : {}),
      state: "exhausted",
      stale,
    };
  }

  // Pace needs both a duration (reported or canonical semantic) and a reset.
  // Resetless 5h rows still carry usedFraction for "% left" without a pace glyph.
  if (!finiteNumber(durationMs) || !finiteNumber(resetsAt)) {
    return { ...base, ...metadata, state: "unknown", stale };
  }

  const toleranceBoundary = tolerance + Number.EPSILON * 8;
  const elapsedFraction = elapsedFractionAt(now, resetsAt, durationMs);
  const paceDelta = elapsedFraction - usedFraction;
  let state: BurndownSegment["state"];
  if (Math.abs(paceDelta) <= toleranceBoundary) state = "on-pace";
  else if (paceDelta > toleranceBoundary) state = "ahead";
  else state = "behind";

  return {
    ...base,
    ...metadata,
    elapsedFraction,
    paceDelta,
    state,
    stale,
  };
}

/** Build display segment(s) for one subscription without mutating its source snapshot. */
export function calculateBurndownSegmentsForSnapshot(
  snapshot: SubscriptionSnapshot,
  options: BurndownOptions = {},
): BurndownSegment[] {
  const now = nowValue(options);
  const tolerance =
    finiteNumber(options.paceTolerance) && options.paceTolerance >= 0
      ? options.paceTolerance
      : DEFAULT_TOLERANCE;
  const skew =
    finiteNumber(options.clockSkewMs) && options.clockSkewMs >= 0
      ? options.clockSkewMs
      : DEFAULT_CLOCK_SKEW_MS;
  const windowView = options.windowView ?? DEFAULT_WINDOW_VIEW;
  const selected = selectWindowsForView(snapshot, windowView, now, skew);
  if (selected.length === 0) {
    return [segmentFromSelection(snapshot, undefined, options, now, tolerance)];
  }
  return selected.map((entry) => segmentFromSelection(snapshot, entry, options, now, tolerance));
}

/** Build one display segment using the default single-window view (5h-first fallback). */
export function calculateBurndownSegment(
  snapshot: SubscriptionSnapshot,
  options: BurndownOptions = {},
): BurndownSegment {
  const segments = calculateBurndownSegmentsForSnapshot(snapshot, {
    ...options,
    windowView: options.windowView ?? DEFAULT_WINDOW_VIEW,
  });
  return (
    segments[0] ?? {
      subscriptionId: snapshot.id,
      provider: snapshot.provider,
      accountId: snapshot.accountId ?? snapshot.id,
      ...(snapshot.tier !== undefined ? { tier: snapshot.tier } : {}),
      label: snapshot.accountLabel ?? snapshot.provider,
      state: "unknown",
      stale: false,
    }
  );
}

/** Calculate segments in snapshot order; callers can apply their own risk sort. */
export function computeBurndownSegments(
  snapshots: readonly SubscriptionSnapshot[],
  options: BurndownOptions = {},
): BurndownSegment[] {
  return snapshots.flatMap((snapshot) => calculateBurndownSegmentsForSnapshot(snapshot, options));
}

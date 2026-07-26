import { visibleWidth } from "@oh-my-pi/pi-tui";
import type {
  AccountLabelsMode,
  DensityMode,
  ExhaustedDisplayMode,
  ExhaustedLabelMode,
  LayoutMode,
} from "../config";
import type { BurndownSegment, SegmentState } from "../domain/types";
import { buildStableLabels, labelFor, providerLabelFor, type StableLabels } from "./labels";
import {
  type BurndownSymbols,
  describeSegmentSignal,
  type SymbolMode,
  segmentSignal,
  segmentSignalWithDensity,
  symbolsFor,
} from "./symbols";

export interface BurndownTheme {
  fg(color: string, text: string): string;
}

export interface BurndownRenderOptions {
  theme?: BurndownTheme;
  symbols?: SymbolMode | BurndownSymbols;
  density?: DensityMode;
  layout?: LayoutMode;
  accountLabels?: AccountLabelsMode;
  exhaustedDisplay?: ExhaustedDisplayMode;
  exhaustedLabel?: ExhaustedLabelMode;
  providerLabelMaxColumns?: number;
  showReset?: boolean;
  now?: number | (() => number);
  separator?: string;
}

const DEFAULT_SEPARATOR = " · ";
const EMPTY_ROWS: readonly string[] = [];

function nowValue(now: number | (() => number) | undefined): number {
  return typeof now === "function" ? now() : (now ?? Date.now());
}

function resetCountdown(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return "";
  const remaining = Math.max(0, resetsAt - now);
  const minute = 60_000;
  const totalMinutes = Math.ceil(remaining / minute);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d${hours > 0 ? `${hours}h` : ""}${minutes > 0 ? `${minutes}m` : ""}`;
  if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

export const formatResetCountdown = resetCountdown;

function riskRank(state: SegmentState, stale: boolean): number {
  if (stale) return 4;
  if (state === "exhausted") return 0;
  if (state === "behind") return 1;
  if (state === "on-pace") return 2;
  if (state === "ahead") return 3;
  return 4;
}

function windowClassRank(segment: BurndownSegment): number {
  if (segment.windowClass === "five_hour") return 0;
  if (segment.windowClass === "week") return 1;
  if (segment.windowClass === "month") return 2;
  if (segment.windowClass === "other") return 3;
  return 4;
}

function accountGroupKey(segment: BurndownSegment): string {
  return segment.accountId ?? segment.subscriptionId;
}

function segmentRiskScore(segment: BurndownSegment): {
  rank: number;
  pace: number;
  subscriptionId: string;
} {
  return {
    rank: riskRank(segment.state, segment.stale),
    pace:
      (segment.state === "behind" || segment.state === "ahead") && !segment.stale
        ? Number.isFinite(segment.paceDelta)
          ? (segment.paceDelta ?? 0)
          : 0
        : 0,
    subscriptionId: segment.subscriptionId,
  };
}

function compareRisk(a: BurndownSegment, b: BurndownSegment): number {
  const left = segmentRiskScore(a);
  const right = segmentRiskScore(b);
  if (left.rank !== right.rank) return left.rank - right.rank;
  if (
    (a.state === "behind" || a.state === "ahead") &&
    (b.state === "behind" || b.state === "ahead") &&
    !a.stale &&
    !b.stale &&
    left.pace !== right.pace
  ) {
    return left.pace - right.pace;
  }
  return left.subscriptionId.localeCompare(right.subscriptionId);
}

/**
 * Sort by account-group risk (worst segment in the group), keep an account's
 * windows contiguous, and order windows canonically: 5h → Wk → Mo → other.
 */
export function sortBurndownSegments(segments: readonly BurndownSegment[]): BurndownSegment[] {
  const groups = new Map<string, BurndownSegment[]>();
  for (const segment of segments) {
    const key = accountGroupKey(segment);
    const group = groups.get(key);
    if (group) group.push(segment);
    else groups.set(key, [segment]);
  }

  const orderedGroups = [...groups.entries()].sort(([, leftSegments], [, rightSegments]) => {
    const leftWorst = [...leftSegments].sort(compareRisk)[0];
    const rightWorst = [...rightSegments].sort(compareRisk)[0];
    if (!leftWorst || !rightWorst) return 0;
    return compareRisk(leftWorst, rightWorst);
  });

  const ordered: BurndownSegment[] = [];
  for (const [, group] of orderedGroups) {
    group.sort((a, b) => {
      const byClass = windowClassRank(a) - windowClassRank(b);
      if (byClass !== 0) return byClass;
      return (a.windowLabel ?? a.windowId ?? "").localeCompare(b.windowLabel ?? b.windowId ?? "");
    });
    ordered.push(...group);
  }
  return ordered;
}

function stableSegmentKey(segments: readonly BurndownSegment[]): string {
  return JSON.stringify(
    [...segments]
      .sort((a, b) => {
        const bySubscription = a.subscriptionId.localeCompare(b.subscriptionId);
        if (bySubscription !== 0) return bySubscription;
        return (a.windowLabel ?? a.windowId ?? "").localeCompare(b.windowLabel ?? b.windowId ?? "");
      })
      .map((segment) => [
        segment.subscriptionId,
        segment.provider,
        segment.label,
        segment.windowId,
        segment.windowClass,
        segment.windowLabel,
        segment.resetsAt,
        segment.usedFraction,
        segment.elapsedFraction,
        segment.paceDelta,
        segment.state,
        segment.stale,
      ]),
  );
}

function colorFor(segment: BurndownSegment): string {
  if (segment.stale || segment.state === "unknown") return "dim";
  if (segment.state === "exhausted") return "error";
  if (segment.state === "behind")
    return Math.abs(segment.paceDelta ?? 0) >= 0.5 ? "error" : "warning";
  if (segment.state === "ahead") return "success";
  return "accent";
}

function style(theme: BurndownTheme | undefined, color: string, text: string): string {
  return theme ? theme.fg(color, text) : text;
}

interface RenderedForms {
  full: string;
  compact: string;
  minimal: string;
}

function remainingQuota(usedFraction: number | undefined): string {
  if (usedFraction === undefined || !Number.isFinite(usedFraction)) return "";
  return `${Math.round(Math.max(0, 1 - usedFraction) * 100)}% left`;
}

function clipToColumns(text: string, maxColumns: number): string {
  if (maxColumns === 0 || visibleWidth(text) <= maxColumns) return text;
  if (maxColumns === 1) return "…";
  let result = "";
  for (const character of text) {
    if (visibleWidth(`${result}${character}…`) > maxColumns) break;
    result += character;
  }
  return `${result}…`;
}

function formsFor(
  segment: BurndownSegment,
  labels: StableLabels,
  symbols: BurndownSymbols,
  density: DensityMode,
  accountLabels: AccountLabelsMode,
  exhaustedDisplay: ExhaustedDisplayMode,
  exhaustedLabel: ExhaustedLabelMode,
  providerLabelMaxColumns: number,
  showReset: boolean,
  now: number,
  theme: BurndownTheme | undefined,
): RenderedForms {
  const color = colorFor(segment);
  const remaining = remainingQuota(segment.usedFraction);
  const reset = showReset ? resetCountdown(segment.resetsAt, now) : "";
  const paceDetails = [remaining, reset].filter(Boolean);
  // Resetless fresh rows with % left omit the hollow "? unknown" pace glyph;
  // stale rows keep it so the stale marker stays visible.
  const omitPaceGlyph = segment.state === "unknown" && !segment.stale && paceDetails.length > 0;
  const fullSignal = omitPaceGlyph
    ? ""
    : style(
        theme,
        color,
        exhaustedLabel === "symbol" && segment.state === "exhausted"
          ? segmentSignal(segment, symbols)
          : describeSegmentSignal(segment, symbols, density),
      );
  const compactSignal = omitPaceGlyph
    ? ""
    : style(theme, color, segmentSignalWithDensity(segment, symbols, density));
  const minimalSignal = omitPaceGlyph ? "" : style(theme, color, segmentSignal(segment, symbols));
  const separator = " ";
  const provider = clipToColumns(
    providerLabelFor(labels, segment.subscriptionId),
    providerLabelMaxColumns,
  );
  const account = labelFor(labels, segment.subscriptionId);
  const hasDistinctAccount =
    labels.accountRequired.has(segment.subscriptionId) &&
    segment.label.trim().length > 0 &&
    segment.label.trim().toLocaleLowerCase() !== segment.provider.trim().toLocaleLowerCase();
  const windowSuffix = segment.windowLabel?.trim();
  const branded = windowSuffix ? `${provider} ${windowSuffix}` : provider;
  const qualifiedLabel =
    !hasDistinctAccount || accountLabels === "provider-only" ? branded : `${branded}:${account}`;
  const fullLabel = style(theme, "muted", qualifiedLabel);
  const withSignal = (signal: string): string =>
    signal ? `${fullLabel}${separator}${signal}` : fullLabel;
  const compact = withSignal(compactSignal);
  const minimal = withSignal(minimalSignal);
  const details =
    segment.state === "exhausted" && exhaustedDisplay === "reset"
      ? [reset].filter(Boolean)
      : [remaining, reset].filter(Boolean);
  const full = details.length
    ? `${withSignal(fullSignal)}${details
        .map((detail) => `${separator}·${separator}${style(theme, "dim", detail)}`)
        .join("")}`
    : withSignal(fullSignal);
  return { full, compact, minimal };
}

/**
 * Pack left-to-right preferring full detail (% left + reset).
 * If the next full form does not fit the remainder but would fit a fresh line,
 * wrap instead of crushing to compact/minimal. Compact/minimal are only used
 * when even an empty line cannot hold the full form.
 */
function packForms(forms: readonly RenderedForms[], width: number, separator: string): string[] {
  const lines: string[] = [];
  let current: string[] = [];
  let used = 0;
  const sepWidth = visibleWidth(separator);

  const flush = (): void => {
    if (current.length === 0) return;
    lines.push(current.join(separator));
    current = [];
    used = 0;
  };

  for (const form of forms) {
    const fullWidth = visibleWidth(form.full);
    const compactWidth = visibleWidth(form.compact);
    const minimalWidth = visibleWidth(form.minimal);
    if (minimalWidth > width) continue;

    const leading = current.length > 0 ? sepWidth : 0;
    const remainder = width - used - leading;

    if (fullWidth <= remainder) {
      current.push(form.full);
      used += leading + fullWidth;
      continue;
    }

    // Full does not fit here; prefer a fresh line if full can stand alone.
    if (fullWidth <= width) {
      flush();
      current.push(form.full);
      used = fullWidth;
      continue;
    }

    // Full never fits a line alone — degrade to the richest form that does.
    const degraded = compactWidth <= width ? form.compact : form.minimal;
    const degradedWidth = visibleWidth(degraded);
    if (current.length > 0 && used + leading + degradedWidth > width) flush();
    const joinLeading = current.length > 0 ? sepWidth : 0;
    current.push(degraded);
    used += joinLeading + degradedWidth;
  }

  flush();
  return lines;
}

/**
 * Maximize how many labeled segments share a line by degrading later forms
 * when needed. Used for layout=fit.
 */
function chooseForms(
  forms: readonly RenderedForms[],
  width: number,
  separator: string,
): string[] | undefined {
  const count = forms.length;
  const separatorsWidth = Math.max(0, count - 1) * visibleWidth(separator);
  const budget = width - separatorsWidth;
  if (budget < 0) return undefined;
  const chosen: string[] = [];
  let used = 0;
  for (let index = 0; index < count; index++) {
    const form = forms[index];
    if (!form) return undefined;
    const remainingMinimum = forms
      .slice(index + 1, count)
      .reduce((sum, value) => sum + visibleWidth(value.minimal), 0);
    const available = budget - used - remainingMinimum;
    const candidate =
      visibleWidth(form.full) <= available
        ? form.full
        : visibleWidth(form.compact) <= available
          ? form.compact
          : visibleWidth(form.minimal) <= available
            ? form.minimal
            : undefined;
    if (!candidate) return undefined;
    chosen.push(candidate);
    used += visibleWidth(candidate);
  }
  return chosen;
}

/** Fit packing: maximize segment count per line under the width budget. */
function fitForms(forms: readonly RenderedForms[], width: number, separator: string): string[] {
  const lines: string[] = [];
  for (let start = 0; start < forms.length; ) {
    let chosen: string[] | undefined;
    let chosenLine: string | undefined;
    for (let count = forms.length - start; count >= 1; count--) {
      const candidate = chooseForms(forms.slice(start, start + count), width, separator);
      if (!candidate) continue;
      const line = candidate.join(separator);
      if (visibleWidth(line) > width) continue;
      chosen = candidate;
      chosenLine = line;
      break;
    }
    if (!chosen || chosenLine === undefined) break;
    lines.push(chosenLine);
    start += chosen.length;
  }
  return lines;
}

/** Render zero or more lines, always within the supplied cell budget. */
export function renderBurndownRow(
  segments: readonly BurndownSegment[],
  width: number,
  optionsOrTheme: BurndownRenderOptions | BurndownTheme = {},
): readonly string[] {
  const options: BurndownRenderOptions =
    "fg" in optionsOrTheme ? { theme: optionsOrTheme } : optionsOrTheme;
  // Host chrome (herdr/OMP borders) can paint one cell tighter than the width
  // passed to render(); keep a 1-cell margin so lines are not mid-wrapped.
  const budget = Math.max(0, Math.floor(width) - 1);
  if (budget <= 0 || segments.length === 0) return EMPTY_ROWS;
  const symbols =
    typeof options.symbols === "object" ? options.symbols : symbolsFor(options.symbols ?? "auto");
  const separator = options.separator ?? DEFAULT_SEPARATOR;
  const sorted = sortBurndownSegments(segments);
  const labels = buildStableLabels(sorted, options.accountLabels === "masked");
  const renderNow = nowValue(options.now);
  const forms = sorted.map((segment) =>
    formsFor(
      segment,
      labels,
      symbols,
      options.density ?? "dense",
      options.accountLabels ?? "full",
      options.exhaustedDisplay ?? "status",
      options.exhaustedLabel ?? "full",
      options.providerLabelMaxColumns ?? 0,
      options.showReset ?? true,
      renderNow,
      options.theme,
    ),
  );
  const renderable = forms.filter((form) => visibleWidth(form.minimal) <= budget);
  const lines =
    options.layout === "wrap"
      ? packForms(renderable, budget, separator)
      : fitForms(renderable, budget, separator);
  return lines.length > 0 ? lines : EMPTY_ROWS;
}

export class BurndownRowComponent {
  readonly theme: BurndownTheme | undefined;
  readonly options: Omit<BurndownRenderOptions, "theme">;
  #segments: readonly BurndownSegment[] = [];
  #semanticKey = "[]";
  #cachedWidth: number | undefined;
  #cachedNow: number | undefined;
  #cachedRows: readonly string[] = EMPTY_ROWS;

  constructor(theme?: BurndownTheme, options: Omit<BurndownRenderOptions, "theme"> = {}) {
    this.theme = theme;
    this.options = options;
  }

  setSegments(segments: readonly BurndownSegment[]): boolean {
    const key = stableSegmentKey(segments);
    if (key === this.#semanticKey) return false;
    this.#segments = segments.map((segment) => ({ ...segment }));
    this.#semanticKey = key;
    this.#cachedWidth = undefined;
    this.#cachedNow = undefined;
    return true;
  }

  render(width: number): readonly string[] {
    const currentNow = nowValue(this.options.now);
    if (this.#cachedWidth === width && this.#cachedNow === currentNow) return this.#cachedRows;
    const renderOptions: BurndownRenderOptions = { ...this.options, now: currentNow };
    if (this.theme) renderOptions.theme = this.theme;
    this.#cachedRows = renderBurndownRow(this.#segments, width, renderOptions);
    this.#cachedWidth = width;
    this.#cachedNow = currentNow;
    return this.#cachedRows;
  }
}

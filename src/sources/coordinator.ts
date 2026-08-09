import type {
  CoordinatorDiagnostic,
  LimitObservation,
  SubscriptionSnapshot,
  UsageSourceId,
} from "../domain/types.ts";
import type { UsageSource } from "./source.ts";

const IDENTITY_RANK: Record<UsageSourceId, number> = {
  "opencode-go-console": 5,
  "omp-auth-storage": 4,
  "omp-broker": 3,
  "provider-endpoint": 2,
  "omp-response": 1,
};

function observationKey(observation: LimitObservation): string {
  const windowId = observation.limit.window?.id ?? observation.limit.scope.windowId ?? "";
  return `${observation.limit.id}\u0000${windowId}`;
}

/**
 * Exact opencode-go console observations outrank OMP's synthetic
 * `omp-observed-request-costs` estimate for the same provider — but only while
 * fresh. When the console session lapses and its data decays to stale, the
 * synthetic estimate takes over again instead of rendering a dead number.
 */
function applyConsolePrecedence(snapshots: SubscriptionSnapshot[]): SubscriptionSnapshot[] {
  const byProvider = new Map<string, SubscriptionSnapshot[]>();
  for (const snapshot of snapshots) {
    const group = byProvider.get(snapshot.provider);
    if (group) group.push(snapshot);
    else byProvider.set(snapshot.provider, [snapshot]);
  }
  const dropped = new Set<SubscriptionSnapshot>();
  for (const group of byProvider.values()) {
    const consoleSnapshots = group.filter(
      (snapshot) => snapshot.identitySource === "opencode-go-console",
    );
    if (consoleSnapshots.length === 0) continue;
    const others = group.filter((snapshot) => snapshot.identitySource !== "opencode-go-console");
    const consoleFresh = consoleSnapshots.some((snapshot) =>
      snapshot.limits.some((limit) => !limit.stale),
    );
    const othersFresh = others.some((snapshot) => snapshot.limits.some((limit) => !limit.stale));
    if (consoleFresh) for (const snapshot of others) dropped.add(snapshot);
    else if (othersFresh) for (const snapshot of consoleSnapshots) dropped.add(snapshot);
  }
  return snapshots.filter((snapshot) => !dropped.has(snapshot));
}

export function mergeSnapshots(groups: readonly SubscriptionSnapshot[][]): SubscriptionSnapshot[] {
  const merged = new Map<string, SubscriptionSnapshot>();
  for (const snapshots of groups) {
    for (const incoming of snapshots) {
      const existing = merged.get(incoming.id);
      if (!existing) {
        merged.set(incoming.id, {
          ...incoming,
          limits: [...incoming.limits],
        });
        continue;
      }
      if (existing.provider !== incoming.provider) continue;

      const observations = new Map(existing.limits.map((item) => [observationKey(item), item]));
      for (const candidate of incoming.limits) {
        const key = observationKey(candidate);
        const current = observations.get(key);
        if (!current || candidate.fetchedAt > current.fetchedAt) observations.set(key, candidate);
      }
      const identityIsStronger =
        IDENTITY_RANK[incoming.identitySource] > IDENTITY_RANK[existing.identitySource];
      const accountLabel = identityIsStronger
        ? (incoming.accountLabel ?? existing.accountLabel)
        : (existing.accountLabel ?? incoming.accountLabel);
      const accountId = existing.accountId ?? incoming.accountId;
      const tier = existing.tier ?? incoming.tier;
      merged.set(incoming.id, {
        id: existing.id,
        provider: existing.provider,
        ...(accountId !== undefined ? { accountId } : {}),
        ...(tier !== undefined ? { tier } : {}),
        ...(accountLabel ? { accountLabel } : {}),
        ...(existing.provisional || incoming.provisional ? { provisional: true } : {}),
        identitySource: identityIsStronger ? incoming.identitySource : existing.identitySource,
        limits: [...observations.values()].sort((a, b) =>
          observationKey(a).localeCompare(observationKey(b)),
        ),
      });
    }
  }
  const snapshots = applyConsolePrecedence([...merged.values()]);
  const identifiedProviders = new Set(
    snapshots
      .filter((snapshot) => snapshot.provisional !== true)
      .map((snapshot) => snapshot.provider),
  );
  return snapshots
    .filter(
      (snapshot) => snapshot.provisional !== true || !identifiedProviders.has(snapshot.provider),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

export class SourceCoordinator {
  readonly #sources: readonly UsageSource[];
  readonly #sourceSnapshots = new Map<string, SubscriptionSnapshot[]>();
  #discoveredProviders: string[] = [];
  #refreshPromise: Promise<SubscriptionSnapshot[]> | undefined;

  constructor(sources: readonly UsageSource[]) {
    this.#sources = sources;
  }

  setDiscoveredProviders(providers: readonly string[]): void {
    this.#discoveredProviders = [...new Set(providers)].sort();
  }

  refresh(signal: AbortSignal): Promise<SubscriptionSnapshot[]> {
    if (this.#refreshPromise) return this.#refreshPromise;
    const refresh = this.#runRefresh(signal).finally(() => {
      if (this.#refreshPromise === refresh) this.#refreshPromise = undefined;
    });
    this.#refreshPromise = refresh;
    return refresh;
  }

  current(): SubscriptionSnapshot[] {
    return mergeSnapshots([...this.#sourceSnapshots.values()]);
  }

  diagnostic(): CoordinatorDiagnostic {
    const current = this.current();
    const reportedProviders = [...new Set(current.map((item) => item.provider))].sort();
    const reported = new Set(reportedProviders);
    return {
      sources: this.#sources.map(
        (source) => source.diagnostic?.() ?? { sourceId: source.id, enabled: true },
      ),
      discoveredProviders: this.#discoveredProviders,
      reportedProviders,
      unavailableProviders: Object.fromEntries(
        this.#discoveredProviders
          .filter((provider) => !reported.has(provider))
          .map((provider) => [
            provider,
            "no host auth report, broker report, supported response headers, or explicit endpoint credential",
          ]),
      ),
      ambiguities: [],
    };
  }

  async #runRefresh(signal: AbortSignal): Promise<SubscriptionSnapshot[]> {
    const results = await Promise.allSettled(
      this.#sources.map(async (source) => ({ source, snapshots: await source.refresh(signal) })),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        this.#sourceSnapshots.set(result.value.source.id, result.value.snapshots);
      }
    }
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    return this.current();
  }
}

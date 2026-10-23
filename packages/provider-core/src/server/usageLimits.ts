import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function sortWindows(
  windows: Iterable<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return [...windows].toSorted(
    (left, right) =>
      WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] ||
      left.id.localeCompare(right.id),
  );
}

export function makeUsageLimits(input: {
  readonly checkedAt: string;
  readonly windows: Iterable<ServerProviderUsageWindow>;
}): ServerProviderUsageLimits {
  return { checkedAt: input.checkedAt, windows: sortWindows(input.windows) };
}

export function makeUnavailableUsageLimits(input: {
  readonly checkedAt: string;
  readonly reason: "unsupported" | "probeFailed";
  readonly message?: string;
}): ServerProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    windows: [],
    unavailable: {
      reason: input.reason,
      ...(input.message ? { message: input.message } : {}),
    },
  };
}

export function applyUsageLimitsUpdate(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly update: ProviderUsageLimitsUpdate;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const { previous, update } = input;
  if (
    (update.windows.length === 0 &&
      (update.recoveryWindows?.length ?? 0) === 0 &&
      update.paidUsageEnabled === undefined &&
      update.paidUsageObserved === undefined) ||
    previous?.unavailable?.reason === "unsupported"
  ) {
    return previous;
  }
  const merged = new Map(previous?.windows.map((window) => [window.id, window] as const));
  // Codex sends this notification beside every token-usage tick, almost
  // always with unchanged numbers. Decide "nothing changed" per window on
  // the way through so the no-op case never allocates a new snapshot.
  let changed =
    update.recoveryWindows !== undefined ||
    (update.paidUsageEnabled !== undefined &&
      update.paidUsageEnabled !== previous?.paidUsageEnabled) ||
    (update.paidUsageObserved !== undefined &&
      update.paidUsageObserved !== previous?.paidUsageObserved);
  for (const window of update.windows) {
    const existing = merged.get(window.id);
    const next: ServerProviderUsageWindow = {
      ...window,
      usedPercent: clampPercent(window.usedPercent),
      ...(window.resetsAt === undefined && existing?.resetsAt !== undefined
        ? { resetsAt: existing.resetsAt }
        : {}),
      ...(window.windowDurationMins === undefined && existing?.windowDurationMins !== undefined
        ? { windowDurationMins: existing.windowDurationMins }
        : {}),
    };
    if (existing === undefined || !usageWindowEquals(existing, next)) {
      merged.set(window.id, next);
      changed = true;
    }
  }
  if (!changed && previous !== undefined && previous.unavailable === undefined) {
    return previous;
  }
  return {
    ...makeUsageLimits({ checkedAt: input.checkedAt, windows: merged.values() }),
    ...((update.recoveryWindows ?? previous?.recoveryWindows) === undefined
      ? {}
      : {
          recoveryWindows: [
            ...new Map(
              [...(previous?.recoveryWindows ?? []), ...(update.recoveryWindows ?? [])].map((w) => [
                w.id,
                w,
              ]),
            ).values(),
          ],
        }),
    ...((update.paidUsageEnabled ?? previous?.paidUsageEnabled) === undefined
      ? {}
      : { paidUsageEnabled: update.paidUsageEnabled ?? previous?.paidUsageEnabled }),
    ...((update.paidUsageObserved ?? previous?.paidUsageObserved) === undefined
      ? {}
      : { paidUsageObserved: update.paidUsageObserved ?? previous?.paidUsageObserved }),
    ...(previous?.completeCheckedAt === undefined
      ? {}
      : { completeCheckedAt: previous.completeCheckedAt }),
    ...(previous?.resetCredits !== undefined ? { resetCredits: previous.resetCredits } : {}),
  };
}

function usageWindowEquals(a: ServerProviderUsageWindow, b: ServerProviderUsageWindow): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.usedPercent === b.usedPercent &&
    a.resetsAt === b.resetsAt &&
    a.windowDurationMins === b.windowDurationMins
  );
}

export function resolveUsageLimitsAfterProbe(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
}): ServerProviderUsageLimits | undefined {
  const { published, probed } = input;
  if (probed?.unavailable?.reason === "probeFailed" && published && !published.unavailable) {
    return published;
  }
  if (published && probed && !probed.unavailable) {
    if (Date.parse(probed.checkedAt) <= Date.parse(published.checkedAt)) return published;
    const windows =
      probed.completeCheckedAt === probed.checkedAt
        ? probed.windows
        : [...new Map([...published.windows, ...probed.windows].map((w) => [w.id, w])).values()];
    return {
      ...probed,
      windows,
      ...((probed.recoveryWindows ?? published.recoveryWindows) === undefined
        ? {}
        : {
            recoveryWindows:
              probed.completeCheckedAt === probed.checkedAt && probed.recoveryWindows !== undefined
                ? probed.recoveryWindows
                : [
                    ...new Map(
                      [...(published.recoveryWindows ?? []), ...(probed.recoveryWindows ?? [])].map(
                        (w) => [w.id, w],
                      ),
                    ).values(),
                  ],
          }),
      ...((probed.paidUsageEnabled ?? published.paidUsageEnabled) === undefined
        ? {}
        : { paidUsageEnabled: probed.paidUsageEnabled ?? published.paidUsageEnabled }),
      ...((probed.paidUsageObserved ?? published.paidUsageObserved) === undefined
        ? {}
        : { paidUsageObserved: probed.paidUsageObserved ?? published.paidUsageObserved }),
    };
  }
  return probed;
}

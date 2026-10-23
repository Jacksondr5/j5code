import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

const WINDOWS: Readonly<
  Record<string, Pick<ServerProviderUsageWindow, "kind" | "label" | "windowDurationMins">>
> = {
  five_hour: { kind: "session", label: "Session", windowDurationMins: SESSION_MINS },
  seven_day: { kind: "weekly", label: "Weekly", windowDurationMins: WEEK_MINS },
};

/**
 * The streamed event names the overage-included bucket by type
 * (`seven_day_overage_included`), while `get_usage` names it by the model's
 * `display_name`. Which model that is changes over time, so the probe records
 * the name it saw and the event mapper reuses it; the mid-turn update then
 * lands on the row the probe drew instead of opening a second one.
 */
const OVERAGE_INCLUDED_EVENT_TYPE = "seven_day_overage_included";

export interface ClaudeScopedLimitNames {
  readonly overageIncluded: string | undefined;
}

export const makeClaudeScopedLimitNames = Ref.make<ClaudeScopedLimitNames>({
  overageIncluded: undefined,
});

function scopedWindowId(displayName: string): string {
  return `seven_day_${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

function scopedWindow(
  displayName: string,
  usedPercent: number,
  resetsAt: string | undefined,
): ServerProviderUsageWindow {
  return {
    id: scopedWindowId(displayName),
    kind: "weekly",
    label: `Weekly · ${displayName}`,
    windowDurationMins: WEEK_MINS,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/**
 * `model_scoped` shipped in the CLI after the SDK typings we pin, so it is
 * read structurally until the `.d.ts` catches up.
 */
interface ModelScopedWindow {
  readonly display_name: string;
  readonly utilization: number | null;
  readonly resets_at: string | null;
}

function readModelScoped(rateLimits: object): ReadonlyArray<ModelScopedWindow> {
  const raw = (rateLimits as { readonly model_scoped?: unknown }).model_scoped;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is ModelScopedWindow =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as ModelScopedWindow).display_name === "string",
  );
}

function isoFromEpochSeconds(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const dt = DateTime.make(value * 1000);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function isoFromString(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const dt = DateTime.make(value);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function makeWindow(
  id: keyof typeof WINDOWS & string,
  usedPercent: number,
  resetsAt: string | undefined,
): ServerProviderUsageWindow {
  const window = WINDOWS[id]!;
  return {
    id,
    ...window,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/**
 * Utilization is a 0–1 fraction on the streamed event. An overage-included
 * event before any probe has named the bucket is dropped: guessing a name
 * would draw a row the next probe cannot reconcile.
 */
export function claudeRateLimitEventToUpdate(
  info: SDKRateLimitInfo,
  names: ClaudeScopedLimitNames,
): ProviderUsageLimitsUpdate | undefined {
  const paid = {
    ...(info.overageStatus === "allowed" || info.overageStatus === "allowed_warning"
      ? { paidUsageEnabled: true }
      : {}),
    ...(info.isUsingOverage || info.overageInUse ? { paidUsageObserved: true } : {}),
  };
  const update = (
    windows: ReadonlyArray<ServerProviderUsageWindow>,
  ): ProviderUsageLimitsUpdate | undefined =>
    windows.length > 0 || Object.keys(paid).length > 0 ? { windows, ...paid } : undefined;
  const type: string | undefined = info.rateLimitType;
  if (!type || typeof info.utilization !== "number") return update([]);
  const usedPercent = info.utilization * 100;
  const resetsAt = isoFromEpochSeconds(info.resetsAt);
  if (type in WINDOWS) return update([makeWindow(type, usedPercent, resetsAt)]);
  if (["seven_day_opus", "seven_day_sonnet", "seven_day_oauth_apps"].includes(type))
    return update([
      {
        id: type,
        kind: "weekly",
        label: `Weekly · ${type.slice(10)}`,
        windowDurationMins: WEEK_MINS,
        usedPercent: clampPercent(usedPercent),
        ...(resetsAt === undefined ? {} : { resetsAt }),
      },
    ]);
  if (type === "overage")
    return update([
      {
        id: type,
        kind: "other",
        label: "Extra usage",
        usedPercent: clampPercent(usedPercent),
        ...(resetsAt === undefined ? {} : { resetsAt }),
      },
    ]);
  if (type === OVERAGE_INCLUDED_EVENT_TYPE && names.overageIncluded)
    return update([scopedWindow(names.overageIncluded, usedPercent, resetsAt)]);
  return update([]);
}

/**
 * Percentages on the `get_usage` response are already 0–100.
 */
export function claudeUsageResponseToLimits(input: {
  readonly response: Pick<SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits">;
  readonly checkedAt: string;
}): { readonly limits: ServerProviderUsageLimits; readonly names: ClaudeScopedLimitNames } {
  const { response, checkedAt } = input;
  if (!response.rate_limits_available || !response.rate_limits) {
    return {
      limits: makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" }),
      names: { overageIncluded: undefined },
    };
  }
  const windows: ServerProviderUsageWindow[] = [];
  const raw: Readonly<Record<string, unknown>> = response.rate_limits;
  let complete = Array.isArray(raw.model_scoped);
  for (const [id, value] of Object.entries(raw)) {
    if (!id.startsWith("seven_day_") || value === null || typeof value !== "object") continue;
    const bucket = value as { readonly utilization?: unknown; readonly resets_at?: string | null };
    if (typeof bucket.utilization !== "number") {
      complete = false;
      continue;
    }
    windows.push({
      id,
      kind: "weekly",
      label: `Weekly · ${id.slice(10)}`,
      windowDurationMins: WEEK_MINS,
      usedPercent: clampPercent(bucket.utilization),
      ...(isoFromString(bucket.resets_at) === undefined
        ? {}
        : { resetsAt: isoFromString(bucket.resets_at)! }),
    });
  }
  const extra = raw.extra_usage as
    | {
        readonly is_enabled?: boolean;
        readonly used_credits?: number | null;
        readonly utilization?: number | null;
      }
    | undefined;

  for (const id of Object.keys(WINDOWS)) {
    const window = response.rate_limits[id as "five_hour" | "seven_day"];
    if (!window || typeof window.utilization !== "number") {
      complete = false;
      continue;
    }
    windows.push(makeWindow(id, window.utilization, isoFromString(window.resets_at)));
  }
  // The CLI filters `model_scoped` to the overage-included allowlist, which
  // today holds one model; the first entry is the one the event refers to.
  let overageIncluded: string | undefined;
  for (const entry of readModelScoped(response.rate_limits)) {
    if (typeof entry.utilization !== "number") {
      complete = false;
      continue;
    }
    windows.push(
      scopedWindow(entry.display_name, entry.utilization, isoFromString(entry.resets_at)),
    );
    overageIncluded ??= entry.display_name;
  }
  return {
    limits: {
      ...makeUsageLimits({ checkedAt, windows }),
      ...(complete ? { completeCheckedAt: checkedAt } : {}),
      ...(extra?.is_enabled === undefined ? {} : { paidUsageEnabled: extra.is_enabled }),
      ...(extra === undefined
        ? {}
        : { paidUsageObserved: (extra.used_credits ?? 0) > 0 || (extra.utilization ?? 0) > 0 }),
    },
    names: { overageIncluded },
  };
}

export const recordClaudeUsageResponse = (
  namesRef: Ref.Ref<ClaudeScopedLimitNames>,
  input: Parameters<typeof claudeUsageResponseToLimits>[0],
): Effect.Effect<ServerProviderUsageLimits> => {
  const { limits, names } = claudeUsageResponseToLimits(input);
  return Ref.set(namesRef, names).pipe(Effect.as(limits));
};

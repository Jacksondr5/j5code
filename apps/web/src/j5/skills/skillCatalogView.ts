import type { SkillCatalogApplyResult } from "@t3tools/contracts";

/**
 * Pure presentation helpers for Settings → Skills. The component owns
 * environment selection and RPC wiring; everything testable lives here.
 */

/** A source edit is saveable only when non-blank and different from configured. */
export function isSourceSaveable(draft: string, configured: string): boolean {
  const trimmed = draft.trim();
  return trimmed.length > 0 && trimmed !== configured;
}

/** Human summary of an apply result: "Installed 3 links, removed 1, 5 unchanged." */
export function summarizeApplyResult(
  result: Pick<SkillCatalogApplyResult, "installed" | "removed" | "unchanged">,
): string {
  return `Installed ${result.installed} links, removed ${result.removed}, ${result.unchanged} unchanged.`;
}

/**
 * Partial apply counts attached to a failed apply error. Guards on the error
 * tag instead of instanceof so a foreign bundle copy still matches.
 */
export function extractPartialApplyResult(cause: unknown): SkillCatalogApplyResult | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const tagged = cause as { readonly _tag?: unknown; readonly result?: unknown };
  if (tagged._tag !== "SkillCatalogError") return undefined;
  const result = tagged.result as Partial<SkillCatalogApplyResult> | undefined;
  if (typeof result !== "object" || result === null) return undefined;
  if (
    typeof result.installed !== "number" ||
    typeof result.removed !== "number" ||
    typeof result.unchanged !== "number" ||
    !Array.isArray(result.selectedGroups)
  ) {
    return undefined;
  }
  return result as SkillCatalogApplyResult;
}

/**
 * Drop selected groups the catalog no longer reports (e.g. an Update removed
 * one). Submitting an unknown group would fail, so pruning on fresh status
 * keeps Apply working without a page reset.
 */
export function pruneSelectedGroups(
  selected: ReadonlyArray<string>,
  knownGroups: ReadonlyArray<{ readonly name: string }>,
): Array<string> {
  const known = new Set(knownGroups.map((group) => group.name));
  return selected.filter((name) => known.has(name));
}

/** Whether a status error is the stale-page guard asking for a source reload. */
export function isSourceChangedError(error: string | null): boolean {
  return /source changed/i.test(error ?? "");
}

/** Scope key for per-catalog UI state: selections and results belong to it. */
export function catalogScopeFor(environmentId: string, configuredSource: string): string {
  return `${environmentId}::${configuredSource}`;
}

export interface CatalogActionableInput {
  readonly busy: boolean;
  readonly isPending: boolean;
  readonly hasData: boolean;
  readonly displayedSource: string;
  readonly configuredSource: string;
}

/**
 * Actions (Apply, Update, group toggles) are enabled only when the input
 * shows the configured source and status has loaded for exactly that source.
 * A failed save leaves the draft visible against the old settings, so Apply
 * stays disabled instead of submitting the previous source; an external
 * A → B change disables actions until B's status arrives instead of
 * submitting A.
 */
export function isCatalogActionable(input: CatalogActionableInput): boolean {
  if (input.busy || input.isPending || !input.hasData) return false;
  return input.displayedSource.trim() === input.configuredSource;
}

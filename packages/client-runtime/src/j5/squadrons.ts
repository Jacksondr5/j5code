import type { EnvironmentId } from "@t3tools/contracts";
import type { ManagedSquadron } from "@t3tools/contracts/j5";
import type { J5ReadSources } from "./readSources.ts";

export type ScopedManagedSquadron = ManagedSquadron & {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly available: boolean;
};

export interface SquadronDirectoryState {
  readonly status: "loading" | "ready" | "partial" | "error";
  readonly squadrons: ReadonlyArray<ScopedManagedSquadron>;
  readonly sources: J5ReadSources<ReadonlyArray<ManagedSquadron>>["sources"];
}

export function mergeSquadronSources(
  input: J5ReadSources<ReadonlyArray<ManagedSquadron>>,
): SquadronDirectoryState {
  const squadrons = input.sources.flatMap((source) =>
    (source.data ?? []).map((squadron) => ({
      ...squadron,
      environmentId: source.environmentId,
      environmentLabel: source.environmentLabel,
      available: source.status === "ready" && source.canOperate,
    })),
  );
  const complete =
    input.isReady &&
    input.sources.every((source) => source.status === "ready" || source.status === "unsupported");
  const hasReady = input.sources.some((source) => source.status === "ready");
  const loading = !input.isReady || input.sources.some((source) => source.status === "loading");
  const status =
    complete && (hasReady || input.sources.length === 0)
      ? "ready"
      : squadrons.length > 0 || hasReady
        ? "partial"
        : loading
          ? "loading"
          : "error";
  return { status, squadrons, sources: input.sources };
}

import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@t3tools/contracts";

/**
 * Why a run failed, as the provider adapter recorded it: the terminal error item of that run. A
 * run can end `failed` with no error item persisted (the adapter died before writing one), so the
 * answer is nullable and callers say "no detail" rather than inventing one.
 */
export const runFailureDetail = (
  projection: OrchestrationV2ThreadProjection,
  runId: RunId,
): OrchestrationV2ProviderFailure | null => {
  const item = projection.turnItems.findLast(
    (candidate) =>
      candidate.runId === runId && candidate.type === "error" && candidate.status === "failed",
  );
  return item?.type === "error" ? item.failure : null;
};

/** One line for a notice: `provider_error — API Error: Can't reach the API server`. */
export const formatRunFailure = (failure: OrchestrationV2ProviderFailure | null) =>
  failure === null ? "no error detail was recorded" : `${failure.class} — ${failure.message}`;

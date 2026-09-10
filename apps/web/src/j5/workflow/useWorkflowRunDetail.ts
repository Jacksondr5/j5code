import { useAtomValue } from "@effect/atom-react";
import type { RunDetail } from "@j5/workflow-contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { formatEnvironmentQueryError } from "../../state/query";
import { toastManager } from "../../components/ui/toast";
import { mutateRun } from "./client";
import {
  refreshWorkflowQueries,
  useWorkflowQuery,
  workflowArtifactsAggregateAtom,
  workflowDefinitionsQuery,
  workflowDetailAtom,
} from "./queries";
import {
  appliedDraftFor,
  appliedFeedbackFor,
  findDefinition,
  gateArtifactMetadata,
  groupActionsByPhase,
  hasOpenActions,
  metadataFrom,
  nonGateArtifacts,
  publicationValidationFor,
  sameMetadata,
  splitGateArtifacts,
  visibleArtifactMetadata,
  type FeedbackDraft,
  type Metadata,
  type MetadataDraft,
} from "./runDetailModel";
import { phaseLabel } from "./presentation";

export type PendingWorkflowAction =
  | "approve"
  | "request_changes"
  | "cancel"
  | "recover"
  | "restart"
  | "save";

export const shouldApplyWorkflowMutation = (
  originSelection: string,
  currentSelection: string,
  responseRunId: string,
) => currentSelection === originSelection && responseRunId === originSelection;

export function useWorkflowRunDetail(environmentId: EnvironmentId, runId: string) {
  const selectedRef = useRef(runId);
  const commandAttempt = useRef<{ payload: string; commandId: string } | null>(null);
  const [mutationRun, setMutationRun] = useState<RunDetail | null>(null);
  const [feedback, setFeedback] = useState<FeedbackDraft | null>(null);
  const [metadataDraft, setMetadataDraft] = useState<MetadataDraft | null>(null);
  const [displacedDraft, setDisplacedDraft] = useState<MetadataDraft | null>(null);
  const [displacedFeedback, setDisplacedFeedback] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{
    message: string;
    runId: string;
    revision: number;
  } | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingWorkflowAction | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);

  const detailQuery = useWorkflowQuery(workflowDetailAtom({ environmentId, input: { runId } }));
  const definitionsQuery = useWorkflowQuery(workflowDefinitionsQuery(environmentId));
  const queriedRun = detailQuery.data;
  const run =
    mutationRun?.id === runId &&
    (queriedRun === null || mutationRun.readVersion >= queriedRun.readVersion)
      ? mutationRun
      : queriedRun;
  const visibleMetadata = useMemo(() => (run ? visibleArtifactMetadata(run) : []), [run]);
  const artifactResults = useAtomValue(
    workflowArtifactsAggregateAtom({
      environmentId,
      input: { runId, artifacts: visibleMetadata },
    }),
  );
  const artifacts = useMemo(
    () => artifactResults.flatMap((result) => Option.getOrNull(AsyncResult.value(result)) ?? []),
    [artifactResults],
  );
  const artifactError = artifactResults.find((result) => result._tag === "Failure");
  const artifactLoading = artifactResults.some((result) => result.waiting);

  useEffect(() => {
    selectedRef.current = runId;
  }, [runId]);
  useEffect(() => {
    setMutationRun(null);
    setFeedback(null);
    setMetadataDraft(null);
    setDisplacedDraft(null);
    setDisplacedFeedback(null);
    setMutationError(null);
    setSuccess(null);
    setCancelOpen(false);
  }, [runId]);

  const gateMetadata = useMemo(() => (run ? gateArtifactMetadata(run) : []), [run]);
  const gateIds = useMemo(() => new Set(gateMetadata.map((item) => item.id)), [gateMetadata]);
  const gateArtifacts = useMemo(
    () => artifacts.filter((item) => gateIds.has(item.id)),
    [artifacts, gateIds],
  );
  const splitGate = useMemo(() => splitGateArtifacts(gateArtifacts), [gateArtifacts]);
  const definition = useMemo(
    () => (run ? findDefinition(definitionsQuery.data ?? [], run) : undefined),
    [definitionsQuery.data, run],
  );
  const publicationValidation = useMemo(
    () => (run ? publicationValidationFor(run, gateArtifacts, artifacts) : undefined),
    [run, gateArtifacts, artifacts],
  );
  const savedMetadata = useMemo(
    () => metadataFrom(gateArtifacts.find((item) => item.phase === "metadata")),
    [gateArtifacts],
  );
  const appliedDraft = run ? appliedDraftFor(metadataDraft, run) : null;
  const metadata: Metadata = appliedDraft ?? savedMetadata;
  const metadataDirty = appliedDraft !== null && !sameMetadata(appliedDraft, appliedDraft.saved);
  const appliedFeedback = run ? appliedFeedbackFor(feedback, run) : null;
  const feedbackText = appliedFeedback?.text ?? "";

  useEffect(() => {
    if (!metadataDraft || !run?.gate || metadataDraft.runId !== run.id) return;
    if (
      metadataDraft.gateRevision === run.gate.revision &&
      metadataDraft.gateHash === run.gate.artifactHash
    )
      return;
    if (!sameMetadata(metadataDraft, metadataDraft.saved)) setDisplacedDraft(metadataDraft);
    setMetadataDraft(null);
    setMutationError(
      "The approval evidence changed. Review the refreshed gate and submit a new decision.",
    );
  }, [metadataDraft, run]);
  useEffect(() => {
    if (
      !feedback ||
      !run?.gate ||
      feedback.runId !== run.id ||
      feedback.gateHash === run.gate.artifactHash
    )
      return;
    if (feedback.text.trim()) setDisplacedFeedback(feedback.text);
    setFeedback(null);
  }, [feedback, run]);

  const submit = useCallback(
    async (
      action: PendingWorkflowAction,
      path: string,
      body: Record<string, unknown>,
      acceptedMessage: string,
    ) => {
      setPendingAction(action);
      setMutationError(null);
      const payload = JSON.stringify({ path, body });
      if (commandAttempt.current?.payload !== payload)
        commandAttempt.current = { payload, commandId: window.crypto.randomUUID() };
      const origin = selectedRef.current;
      try {
        const next = await mutateRun(path, {
          ...body,
          commandId: commandAttempt.current.commandId,
        });
        commandAttempt.current = null;
        setSuccess({ message: acceptedMessage, runId: next.id, revision: next.revision });
        toastManager.add({ type: "success", title: acceptedMessage });
        if (shouldApplyWorkflowMutation(origin, selectedRef.current, next.id)) {
          setMutationRun(next);
          setFeedback(null);
          if (action === "save") {
            const saved = {
              commitMessage: String(body.commitMessage ?? ""),
              title: String(body.title ?? ""),
              body: String(body.body ?? ""),
            };
            setMetadataDraft(
              next.gate
                ? {
                    ...saved,
                    saved,
                    runId: next.id,
                    gateRevision: next.gate.revision,
                    gateHash: next.gate.artifactHash,
                  }
                : null,
            );
          } else setMetadataDraft(null);
        }
        refreshWorkflowQueries();
      } catch (cause) {
        const message = String(cause);
        setMutationError(message);
        toastManager.add({
          type: "error",
          title: `${phaseLabel(action)} failed`,
          description: message,
        });
        if (/changed|conflict|revision|gate/i.test(message) && origin === selectedRef.current) {
          setMutationRun(null);
          detailQuery.refresh();
        }
      } finally {
        setPendingAction(null);
      }
    },
    [detailQuery],
  );

  const decide = useCallback(
    (decision: "approve" | "request_changes" | "cancel") => {
      if (!run?.gate) return;
      const accepted =
        decision === "approve"
          ? run.phase === "publication_approval"
            ? "Publication approved; publishing"
            : "Plan approved; implementation starting"
          : decision === "request_changes"
            ? run.phase === "publication_approval"
              ? "Changes requested; returning to implementation"
              : "Changes requested; revising the plan"
            : "Cancellation requested";
      void submit(
        decision === "cancel" ? "cancel" : decision,
        `/${encodeURIComponent(run.id)}/decide`,
        {
          expectedRevision: run.revision,
          gateRevision: run.gate.revision,
          artifactHash: run.gate.artifactHash,
          decision,
          feedback: feedbackText,
        },
        accepted,
      );
    },
    [feedbackText, run, submit],
  );

  const beginDraft = useCallback(
    (patch: Partial<Metadata>) => {
      if (!run?.gate) return;
      const basis = appliedDraft ?? {
        ...savedMetadata,
        saved: savedMetadata,
        runId: run.id,
        gateRevision: run.gate.revision,
        gateHash: run.gate.artifactHash,
      };
      setMetadataDraft({ ...basis, ...patch });
    },
    [appliedDraft, run, savedMetadata],
  );

  return {
    run,
    definition,
    artifacts,
    gateArtifacts,
    gateEvidence: splitGate.evidence,
    gateReviews: splitGate.reviews,
    publicationValidation,
    metadata,
    metadataDirty,
    feedbackText,
    setFeedback,
    beginDraft,
    displacedDraft,
    displacedFeedback,
    mutationError,
    setMutationError,
    success:
      success && run && success.runId === run.id && success.revision === run.revision
        ? success.message
        : null,
    pendingAction,
    cancelOpen,
    setCancelOpen,
    submit,
    decide,
    artifactLoading,
    artifactError:
      artifactError?._tag === "Failure" ? formatEnvironmentQueryError(artifactError.cause) : null,
    readError: detailQuery.error ?? definitionsQuery.error,
    actionGroups: run ? groupActionsByPhase(run.actions) : [],
    historicalArtifacts: run ? nonGateArtifacts(run) : [],
    hasOpenActions: run ? hasOpenActions(run.actions) : false,
  };
}

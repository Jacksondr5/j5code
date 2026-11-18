import { isOwnerAccess } from "@t3tools/client-runtime/j5/sharing";
import { j5LedgerSupported } from "@t3tools/client-runtime/j5/readSources";
import { Link } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useThreadShell } from "../../state/entities";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { levelReaches, type PlaybookCheckpoint } from "@t3tools/contracts/j5";
import * as Cause from "effect/Cause";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { ComposerBanner } from "../../components/chat/ComposerBanner";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import {
  j5Environment,
  j5Sharing,
  playbookCheckpointsQueryAtom,
  playbookCheckpointSourcesAtom,
  refreshJ5Sources,
} from "../state";
import { createVisibleRefreshHook, useVisibleRefresh } from "../useVisibleRefresh";

const refresh = (environmentId?: EnvironmentId) =>
  refreshJ5Sources(playbookCheckpointSourcesAtom, playbookCheckpointsQueryAtom, {
    force: true,
    ...(environmentId ? { environmentId } : {}),
  });
const useRefresh = createVisibleRefreshHook(() => {
  void refresh();
});
export function usePlaybookCheckpoints() {
  const sources = useAtomValue(playbookCheckpointSourcesAtom);
  useRefresh();
  return sources.sources.flatMap((source) =>
    (source.data?.requests ?? []).map((request) => ({
      request,
      environmentId: source.environmentId,
      connected: source.connected && source.status === "ready",
    })),
  );
}

export function PlaybookCheckpointCard({
  request,
  environmentId,
  connected = true,
}: {
  request: PlaybookCheckpoint;
  environmentId: EnvironmentId;
  connected?: boolean;
}) {
  const ownerRef = scopeThreadRef(environmentId, request.ownerThreadId);
  const owner = useThreadShell(ownerRef);
  const permission = useAtomValue(
    j5Environment.answerPlaybookCheckpoint.permissionAtom(environmentId),
  );
  const level = useAtomValue(j5Sharing.threadLevel(environmentId, request.ownerThreadId));
  const access = useAtomValue(j5Sharing.connectionAccess(environmentId));
  const canAnswer = permission && levelReaches(level, "collaborator") && connected;
  const canApprove = canAnswer && (request.kind !== "persona_picks" || isOwnerAccess(access));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = async (decision: "approve" | "decline") => {
    setBusy(true);
    setError(null);
    try {
      const result = await j5Environment.answerPlaybookCheckpoint.run(appAtomRegistry, {
        environmentId,
        input: {
          threadId: request.ownerThreadId,
          requestId: request.requestId,
          decision,
          ...(decision === "decline" && reason.trim() ? { reason: reason.trim() } : {}),
        },
      });
      if (result._tag === "Failure") {
        const cause = Cause.squash(result.cause);
        setError(cause instanceof Error ? cause.message : "Could not answer the checkpoint.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not answer the checkpoint.");
    }
    await refresh(environmentId).catch(() => undefined);
    setBusy(false);
  };
  return (
    <section
      aria-label={`Approval: ${request.stepTitle}`}
      className="space-y-2 rounded-lg border border-border bg-card px-4 py-3 text-sm"
    >
      <Link
        to="/$environmentId/$threadId"
        params={buildThreadRouteParams(ownerRef)}
        className="text-muted-foreground underline"
      >
        {owner?.title ?? "Open owner chat"}
      </Link>
      <h3 className="font-medium">{request.stepTitle} · Approval required</h3>
      <p className="whitespace-pre-wrap break-words">{request.summary}</p>
      <Textarea
        aria-label="Reason for declining (optional)"
        placeholder="Reason for declining (optional)"
        value={reason}
        maxLength={4000}
        disabled={!canAnswer || busy}
        onChange={(event) => setReason(event.target.value)}
      />
      <div className="flex gap-2">
        <Button size="sm" disabled={!canApprove || busy} onClick={() => void answer("approve")}>
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canAnswer || busy}
          onClick={() => void answer("decline")}
        >
          Decline
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function PlaybookCheckpointGate({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const environment = useEnvironment(environmentId);
  const query = useEnvironmentQuery(
    j5LedgerSupported(environment?.serverConfig) === false
      ? null
      : j5Environment.playbookCheckpoints({ environmentId, input: { threadId } }),
  );
  useVisibleRefresh(
    query.refresh,
    environment?.connection.phase === "connected" && !query.isPending,
  );
  const requests = (query.data?.requests ?? []).filter(
    (request) => request.ownerThreadId === threadId,
  );
  if (requests.length === 0) return null;
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root density="comfortable">
        {requests.map((request) => (
          <PlaybookCheckpointCard
            key={request.requestId}
            request={request}
            environmentId={environmentId}
            connected={!query.error && environment?.connection.phase === "connected"}
          />
        ))}
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}

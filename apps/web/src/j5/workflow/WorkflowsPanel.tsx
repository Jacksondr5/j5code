import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { Button } from "../../components/ui/button";
import { ScrollArea } from "../../components/ui/scroll-area";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useSquadronAmbientScope } from "../squadron/SquadronDraftState";
import { CreateWorkflowDialog } from "./CreateWorkflowDialog";
import WorkflowRunDetail from "./WorkflowRunDetail";
import { WorkflowRunList } from "./WorkflowRunList";
import { useWorkflowQuery, workflowListAtom } from "./queries";
import { useCreateWorkflow } from "./useCreateWorkflow";
import { effectiveWorkflowPanelOffset, useWorkflowPanelStore } from "./workflowPanelStore";

export default function WorkflowsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const ambientScope = useSquadronAmbientScope() ?? "";
  const navigate = useNavigate();
  const selectedRunId = useWorkflowPanelStore((state) => state.selectedRunId);
  const storedScope = useWorkflowPanelStore((state) => state.scope);
  const storedOffset = useWorkflowPanelStore((state) => state.offset);
  const offset = effectiveWorkflowPanelOffset(
    { scope: storedScope, offset: storedOffset },
    ambientScope,
  );
  const selectRun = useWorkflowPanelStore((state) => state.selectRun);
  const setOffset = useWorkflowPanelStore((state) => state.setOffset);
  const onCreated = useCallback(
    (run: { id: string; squadronId: string }) => {
      setOffset(run.squadronId, 0);
      selectRun(run.id);
    },
    [selectRun, setOffset],
  );
  const creation = useCreateWorkflow(onCreated);
  const listQuery = useWorkflowQuery(
    environmentId === null || selectedRunId !== null
      ? null
      : workflowListAtom({
          environmentId,
          input: {
            squadronId: ambientScope,
            search: "",
            status: "",
            page: Math.floor(offset / 20),
            pageSize: 20,
          },
        }),
  );
  const select = useCallback((id: string) => selectRun(id), [selectRun]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-3">
        {selectedRunId ? (
          <Button size="sm" variant="ghost" onClick={() => selectRun(null)}>
            Workflows
          </Button>
        ) : null}
        <Button size="sm" onClick={() => creation.setOpen(true)}>
          New workflow
        </Button>
        <Button
          size="sm"
          variant="outline"
          render={
            <Link
              to="/runs"
              search={{
                runId: undefined,
                squadronId: ambientScope || undefined,
                newWorkflow: undefined,
              }}
            />
          }
        >
          All workflows
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="min-w-0 p-3">
          {selectedRunId && environmentId ? (
            <WorkflowRunDetail
              environmentId={environmentId}
              runId={selectedRunId}
              onOpenThread={(threadId) =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId, threadId } as never,
                })
              }
            />
          ) : null}
          {!selectedRunId && listQuery.isPending && !listQuery.data ? (
            <p className="rounded border p-4 text-sm">Loading workflows…</p>
          ) : null}
          {!selectedRunId && listQuery.error ? (
            <p role="alert" className="rounded border border-destructive p-4 text-sm">
              Workflows unavailable: {listQuery.error}
            </p>
          ) : null}
          {!selectedRunId && listQuery.data ? (
            <WorkflowRunList
              runs={listQuery.data.runs}
              total={listQuery.data.total}
              offset={offset}
              selected={null}
              hasError={false}
              pageSize={20}
              onCreate={() => creation.setOpen(true)}
              onOffset={(next) => setOffset(ambientScope, next)}
              onSelect={select}
            />
          ) : null}
        </div>
      </ScrollArea>
      <CreateWorkflowDialog
        open={creation.open}
        onOpenChange={creation.setOpen}
        squadrons={creation.squadrons}
        initialSquadron={ambientScope}
        pending={creation.pending}
        loading={creation.squadronsLoading}
        error={creation.squadronError}
        onStart={(input) => void creation.start(input)}
      />
    </div>
  );
}

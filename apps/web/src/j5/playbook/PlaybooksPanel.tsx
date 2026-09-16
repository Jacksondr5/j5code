import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { Button } from "../../components/ui/button";
import { ScrollArea } from "../../components/ui/scroll-area";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useSquadronAmbientScope } from "../squadron/SquadronDraftState";
import { CreatePlaybookDialog } from "./CreatePlaybookDialog";
import PlaybookRunDetail from "./PlaybookRunDetail";
import { PlaybookRunList } from "./PlaybookRunList";
import { usePlaybookQuery, playbookBoardAtom, playbookDefinitionsQuery } from "./queries";
import { useCreatePlaybook } from "./useCreatePlaybook";
import { effectivePlaybookPanelOffset, usePlaybookPanelStore } from "./playbookPanelStore";

export default function PlaybooksPanel() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const ambientRef = useSquadronAmbientScope();
  const environmentId = ambientRef?.environmentId ?? primaryEnvironmentId;
  const ambientScope = ambientRef?.squadronId ?? "";
  const panelScope = `${environmentId}:${ambientScope}`;
  const navigate = useNavigate();
  const selectedRunId = usePlaybookPanelStore((state) =>
    state.selectedEnvironmentId === environmentId ? state.selectedRunId : null,
  );
  const storedScope = usePlaybookPanelStore((state) => state.scope);
  const storedOffset = usePlaybookPanelStore((state) => state.offset);
  const offset = effectivePlaybookPanelOffset(
    { scope: storedScope, offset: storedOffset },
    panelScope,
  );
  const selectRun = usePlaybookPanelStore((state) => state.selectRun);
  const setOffset = usePlaybookPanelStore((state) => state.setOffset);
  const tab = usePlaybookPanelStore((state) => state.tab);
  const setTab = usePlaybookPanelStore((state) => state.setTab);
  const onCreated = useCallback(
    (run: { id: string; squadronId: string }) => {
      setOffset(`${environmentId}:${run.squadronId}`, 0);
      selectRun(environmentId, run.id);
    },
    [environmentId, selectRun, setOffset],
  );
  const creation = useCreatePlaybook(environmentId, onCreated);
  const listQuery = usePlaybookQuery(
    environmentId === null || selectedRunId !== null
      ? null
      : playbookBoardAtom({
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
  const definitions = usePlaybookQuery(
    environmentId === null ? null : playbookDefinitionsQuery(environmentId),
  );
  const select = useCallback(
    (id: string) => selectRun(environmentId, id),
    [environmentId, selectRun],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-3">
        {selectedRunId ? (
          <Button size="sm" variant="ghost" onClick={() => selectRun(environmentId, null)}>
            Playbooks
          </Button>
        ) : null}
        <Button size="sm" onClick={() => creation.setOpen(true)}>
          New playbook
        </Button>
        <Button
          size="sm"
          variant="outline"
          render={
            <Link
              to="/runs"
              search={{
                environmentId: environmentId ?? undefined,
                runId: undefined,
                squadronId: ambientScope || undefined,
                newPlaybook: undefined,
                view: "board",
              }}
            />
          }
        >
          Open board
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="min-w-0 p-3">
          {selectedRunId && environmentId ? (
            <PlaybookRunDetail
              environmentId={environmentId}
              layout="stacked"
              runId={selectedRunId}
              tab={tab}
              onTabChange={setTab}
              onOpenThread={(threadId) =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId, threadId } as never,
                })
              }
            />
          ) : null}
          {!selectedRunId && listQuery.isPending && !listQuery.data ? (
            <p className="rounded border p-4 text-sm">Loading playbooks…</p>
          ) : null}
          {!selectedRunId && listQuery.error ? (
            <p role="alert" className="rounded border border-destructive p-4 text-sm">
              Playbooks unavailable: {listQuery.error}
            </p>
          ) : null}
          {!selectedRunId && listQuery.data ? (
            <PlaybookRunList
              runs={listQuery.data.cards}
              cards={listQuery.data.cards}
              definitions={definitions.data ?? []}
              total={listQuery.data.total}
              offset={offset}
              selected={null}
              hasError={false}
              pageSize={20}
              onCreate={() => creation.setOpen(true)}
              onOffset={(next) => setOffset(panelScope, next)}
              onSelect={select}
            />
          ) : null}
        </div>
      </ScrollArea>
      <CreatePlaybookDialog
        open={creation.open}
        onOpenChange={creation.setOpen}
        squadrons={creation.squadrons}
        initialSquadron={ambientScope}
        pending={creation.pending}
        loading={creation.squadronsLoading}
        error={creation.squadronError}
        definitions={creation.definitions}
        onStart={(input) => void creation.start(input)}
      />
    </div>
  );
}

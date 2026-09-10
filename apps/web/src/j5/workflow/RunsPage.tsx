import type { WorkflowEntry } from "@j5/workflow-contracts/sidebar";
import { Link, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SidebarInset } from "../../components/ui/sidebar";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useSquadronDirectory } from "../squadron/SquadronDirectory";
import { CreateWorkflowDialog } from "./CreateWorkflowDialog";
import WorkflowRunDetail from "./WorkflowRunDetail";
import { WorkflowRunList } from "./WorkflowRunList";
import { useWorkflowQuery, workflowListAtom } from "./queries";
import { statusPresentation } from "./presentation";
import { useCreateWorkflow } from "./useCreateWorkflow";

export function RunsPage() {
  const environmentId = usePrimaryEnvironmentId();
  const search = useSearch({ from: "/runs" });
  const navigate = useNavigate();
  const targetHash = useLocation({ select: (location) => location.hash });
  const directory = useSquadronDirectory();
  const [scope, setScope] = useState(search.squadronId ?? "");
  const [offset, setOffset] = useState(0);
  const [searchText, setSearchText] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const selected = search.runId ?? null;

  const setSelected = useCallback(
    (id: string | null, squadronId = scope) => {
      void navigate({
        to: "/runs",
        search: {
          runId: id ?? undefined,
          squadronId: squadronId || undefined,
          newWorkflow: undefined,
        },
        hash: id ? "workflow-approval" : "",
        replace: true,
      });
    },
    [navigate, scope],
  );

  const onCreated = useCallback(
    (run: { id: string; squadronId: string }) => {
      setScope(run.squadronId);
      setOffset(0);
      setSelected(run.id, run.squadronId);
    },
    [setSelected],
  );
  const creation = useCreateWorkflow(onCreated);

  useEffect(() => {
    if (search.squadronId !== undefined && search.squadronId !== scope) {
      setScope(search.squadronId);
      setOffset(0);
    }
    if (search.newWorkflow === true) creation.setOpen(true);
  }, [creation.setOpen, scope, search.newWorkflow, search.squadronId]);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedSearch(searchText);
      setOffset(0);
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [searchText]);

  const listQuery = useWorkflowQuery(
    environmentId === null
      ? null
      : workflowListAtom({
          environmentId,
          input: {
            squadronId: scope,
            search: debouncedSearch,
            status: statusFilter,
            page: Math.floor(offset / 50),
            pageSize: 50,
          },
        }),
  );
  const runs: readonly WorkflowEntry[] = listQuery.data?.runs ?? [];
  const total = listQuery.data?.total ?? 0;
  const directoryError = directory.status === "error" ? directory.error : null;
  const pageError = directoryError ?? listQuery.error;

  return (
    <SidebarInset className="min-h-0 overflow-y-auto">
      <main className="mx-auto w-full max-w-6xl space-y-6 p-4 wco:pt-[calc(env(titlebar-area-height)+1rem)] sm:p-6 sm:wco:pt-[calc(env(titlebar-area-height)+1.5rem)]">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Workflows</h1>
            <p className="text-sm text-muted-foreground">
              Development requests, recorded evidence, and human decisions.
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => creation.setOpen(true)}>New workflow</Button>
            <Link className="self-center underline" to="/">
              Back to threads
            </Link>
          </div>
        </header>
        {pageError ? (
          <p role="alert" className="rounded border border-destructive p-3">
            Workflow data unavailable: {pageError}
          </p>
        ) : null}
        {creation.mutationError ? (
          <p role="alert" className="rounded border border-destructive p-3">
            {creation.mutationError}
          </p>
        ) : null}
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            Browse Squadron
            <select
              className="mt-1 block rounded border bg-background p-2"
              value={scope}
              onChange={(event) => {
                setScope(event.target.value);
                setOffset(0);
                setSelected(null, event.target.value);
              }}
            >
              <option value="">All Squadrons</option>
              {directory.squadrons.map((item) => (
                <option key={item.squadron.id} value={item.squadron.id}>
                  {item.squadron.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Search
            <Input
              className="mt-1 w-56"
              onChange={(event) => setSearchText(event.currentTarget.value)}
              placeholder="Request text"
              value={searchText}
            />
          </label>
          <label className="text-sm">
            Status
            <select
              className="mt-1 block rounded border bg-background p-2"
              onChange={(event) => {
                setStatusFilter(event.currentTarget.value);
                setOffset(0);
              }}
              value={statusFilter}
            >
              <option value="">All statuses</option>
              {Object.keys(statusPresentation).map((status) => (
                <option key={status} value={status}>
                  {statusPresentation[status as keyof typeof statusPresentation].label}
                </option>
              ))}
            </select>
          </label>
          <span className="pb-2 text-sm text-muted-foreground">
            {total} {total === 1 ? "workflow" : "workflows"}
          </span>
        </div>
        <div className="grid gap-6 md:grid-cols-[17rem_minmax(0,1fr)]">
          <WorkflowRunList
            hasError={pageError !== null}
            offset={offset}
            onCreate={() => creation.setOpen(true)}
            onOffset={setOffset}
            onSelect={setSelected}
            runs={runs}
            selected={selected}
            total={total}
          />
          {!selected ? (
            <section className="rounded-lg border p-8 text-center">
              <h2 className="font-semibold">Select a workflow</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Choose one from the list, or start a new workflow.
              </p>
            </section>
          ) : environmentId ? (
            <WorkflowRunDetail
              environmentId={environmentId}
              runId={selected}
              revealApproval={targetHash === "workflow-approval"}
            />
          ) : null}
        </div>
      </main>
      <CreateWorkflowDialog
        open={creation.open}
        onOpenChange={creation.setOpen}
        squadrons={creation.squadrons}
        initialSquadron={scope}
        pending={creation.pending}
        loading={creation.squadronsLoading}
        error={creation.squadronError}
        onStart={(input) => void creation.start(input)}
      />
    </SidebarInset>
  );
}

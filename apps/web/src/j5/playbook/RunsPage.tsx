import type { PlaybookEntry } from "@j5/playbook-contracts/sidebar";
import { Link, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SidebarInset } from "../../components/ui/sidebar";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useSquadronDirectory } from "../squadron/SquadronDirectory";
import { CreatePlaybookDialog } from "./CreatePlaybookDialog";
import { statusPresentation } from "./presentation";
import { usePlaybookQuery, playbookListAtom } from "./queries";
import { effectiveTab, effectiveView, serializeRunsSearch, type RunsSearch } from "./runsSearch";
import { useCreatePlaybook } from "./useCreatePlaybook";
import { PlaybookBoard } from "./PlaybookBoard";
import PlaybookRunDetail from "./PlaybookRunDetail";
import { PlaybookRunList } from "./PlaybookRunList";

function PlaybookSearchInput({
  initialValue,
  onCommit,
}: {
  readonly initialValue: string;
  readonly onCommit: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const lastCommitted = useRef(initialValue);

  useEffect(() => {
    if (initialValue !== lastCommitted.current) {
      lastCommitted.current = initialValue;
      setValue(initialValue);
    }
  }, [initialValue]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      lastCommitted.current = value.trim();
      onCommit(value.trim());
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [onCommit, value]);
  return (
    <Input
      className="mt-1 h-9 w-full"
      onChange={(event) => setValue(event.currentTarget.value)}
      placeholder="Request text"
      value={value}
    />
  );
}

export function RunsPage() {
  const environmentId = usePrimaryEnvironmentId();
  const search = useSearch({ from: "/runs" });
  const navigate = useNavigate();
  const targetHash = useLocation({ select: (location) => location.hash });
  const directory = useSquadronDirectory();
  const scope = search.squadronId ?? "";
  const page = search.page ?? 0;
  const selected = search.runId ?? null;
  const view = effectiveView(search);
  const tab = effectiveTab(search, targetHash);

  const updateSearch = useCallback(
    (patch: Partial<RunsSearch>, hash?: string) => {
      void navigate({
        to: "/runs",
        search: (current) => serializeRunsSearch({ ...current, ...patch }),
        ...(hash === undefined ? {} : { hash }),
        replace: true,
      });
    },
    [navigate],
  );
  const setSelected = useCallback(
    (id: string | null, squadronId = scope) =>
      updateSearch(
        {
          runId: id ?? undefined,
          squadronId: squadronId || undefined,
          newPlaybook: undefined,
          tab: undefined,
        },
        "",
      ),
    [scope, updateSearch],
  );
  const onCreated = useCallback(
    (run: { id: string; squadronId: string }) =>
      updateSearch(
        {
          runId: run.id,
          squadronId: run.squadronId,
          newPlaybook: undefined,
          page: undefined,
          tab: undefined,
        },
        "",
      ),
    [updateSearch],
  );
  const creation = useCreatePlaybook(onCreated);
  const setCreationOpen = creation.setOpen;
  const setQuery = useCallback(
    (value: string) => {
      const q = value || undefined;
      if (q !== search.q) updateSearch({ q, page: undefined });
    },
    [search.q, updateSearch],
  );

  useEffect(() => {
    if (search.newPlaybook === true) setCreationOpen(true);
  }, [search.newPlaybook, setCreationOpen]);

  const listQuery = usePlaybookQuery(
    environmentId === null || (view === "board" && selected === null)
      ? null
      : playbookListAtom({
          environmentId,
          input: {
            squadronId: scope,
            search: search.q ?? "",
            status: search.status ?? "",
            page,
            pageSize: 50,
          },
        }),
  );
  const runs: readonly PlaybookEntry[] = listQuery.data?.runs ?? [];
  const total = listQuery.data?.total ?? 0;
  const directoryError = directory.status === "error" ? directory.error : null;
  const pageError = directoryError ?? listQuery.error;

  return (
    <SidebarInset className="min-h-0 overflow-y-auto">
      <main className="mx-auto w-full max-w-7xl space-y-6 p-4 wco:pt-[calc(env(titlebar-area-height)+1rem)] sm:p-6 sm:wco:pt-[calc(env(titlebar-area-height)+1.5rem)]">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Playbooks</h1>
            <p className="text-sm text-muted-foreground">
              Development requests, recorded evidence, and human decisions.
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => setCreationOpen(true)}>New playbook</Button>
            <Link className="self-center underline" to="/">
              Back to threads
            </Link>
          </div>
        </header>
        {pageError ? (
          <p role="alert" className="rounded border border-destructive p-3">
            Playbook data unavailable: {pageError}
          </p>
        ) : null}
        {creation.mutationError ? (
          <p role="alert" className="rounded border border-destructive p-3">
            {creation.mutationError}
          </p>
        ) : null}
        <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-muted/20 p-3">
          <label className="text-sm">
            Squadron
            <select
              className="mt-1 block h-9 w-48 rounded border bg-background px-2"
              value={scope}
              onChange={(event) =>
                updateSearch({
                  squadronId: event.target.value || undefined,
                  runId: undefined,
                  page: undefined,
                  tab: undefined,
                })
              }
            >
              <option value="">All Squadrons</option>
              {directory.squadrons.map((item) => (
                <option key={item.squadron.id} value={item.squadron.id}>
                  {item.squadron.name}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-48 flex-1 text-sm">
            Search
            <PlaybookSearchInput initialValue={search.q ?? ""} onCommit={setQuery} />
          </label>
          <label className="text-sm">
            Status
            <select
              className="mt-1 block h-9 rounded border bg-background px-2"
              onChange={(event) =>
                updateSearch({
                  status: (event.currentTarget.value || undefined) as RunsSearch["status"],
                  page: undefined,
                })
              }
              value={search.status ?? ""}
            >
              <option value="">All statuses</option>
              {Object.keys(statusPresentation).map((status) => (
                <option key={status} value={status}>
                  {statusPresentation[status as keyof typeof statusPresentation].label}
                </option>
              ))}
            </select>
          </label>
          <div aria-label="Playbook view" className="flex rounded border p-1">
            <Button
              aria-pressed={view === "board"}
              size="sm"
              variant={view === "board" ? "secondary" : "ghost"}
              onClick={() => updateSearch({ view: "board", runId: undefined, tab: undefined })}
            >
              Board
            </Button>
            <Button
              aria-pressed={view === "list"}
              size="sm"
              variant={view === "list" ? "secondary" : "ghost"}
              onClick={() => updateSearch({ view: "list" })}
            >
              List
            </Button>
          </div>
          {view === "list" ? (
            <span className="pb-2 text-sm text-muted-foreground">
              {total} {total === 1 ? "playbook" : "playbooks"}
            </span>
          ) : null}
        </div>
        {view === "board" && selected === null && environmentId ? (
          <PlaybookBoard
            environmentId={environmentId}
            onPage={(next) => updateSearch({ page: next || undefined })}
            onSelect={(id, squadronId) =>
              updateSearch(
                {
                  runId: id,
                  squadronId,
                  newPlaybook: undefined,
                  view: "board",
                  tab: undefined,
                },
                "",
              )
            }
            page={page}
            q={search.q ?? ""}
            squadronId={scope}
            status={search.status ?? ""}
          />
        ) : (
          <div className="grid gap-6 md:grid-cols-[17rem_minmax(0,1fr)]">
            <PlaybookRunList
              hasError={pageError !== null}
              offset={page * 50}
              onCreate={() => setCreationOpen(true)}
              onOffset={(next) =>
                updateSearch({ page: next > 0 ? Math.floor(next / 50) : undefined })
              }
              onSelect={setSelected}
              runs={runs}
              selected={selected}
              total={total}
            />
            {!selected ? (
              <section className="rounded-lg border p-8 text-center">
                <h2 className="font-semibold">Select a playbook</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Choose one from the list, or start a new playbook.
                </p>
              </section>
            ) : environmentId ? (
              <PlaybookRunDetail
                environmentId={environmentId}
                onTabChange={(next) => updateSearch({ tab: next }, "")}
                revealApproval={targetHash.replace(/^#/u, "") === "playbook-approval"}
                runId={selected}
                tab={tab}
              />
            ) : null}
          </div>
        )}
      </main>
      <CreatePlaybookDialog
        open={creation.open}
        onOpenChange={creation.setOpen}
        squadrons={creation.squadrons}
        initialSquadron={scope}
        pending={creation.pending}
        loading={creation.squadronsLoading}
        error={creation.squadronError}
        definitions={creation.definitions}
        onStart={(input) => void creation.start(input)}
      />
    </SidebarInset>
  );
}

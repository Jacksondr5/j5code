import { useMemo, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import type { ManagedSquadron } from "../squadron/squadronClient";
import type { PlaybookDefinitionPresentation } from "@j5/playbook-contracts";

export function CreatePlaybookDialog({
  open,
  onOpenChange,
  squadrons,
  initialSquadron,
  pending,
  loading,
  error,
  definitions,
  onStart,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly squadrons: readonly ManagedSquadron[];
  readonly initialSquadron: string;
  readonly pending: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly definitions: readonly PlaybookDefinitionPresentation[];
  readonly onStart: (input: {
    readonly squadronId: string;
    readonly definitionId: string;
    readonly request: string;
    readonly baseRef: string;
  }) => void;
}) {
  const eligible = useMemo(
    () => squadrons.filter((item) => item.projectIds.length === 1),
    [squadrons],
  );
  const [squadronId, setSquadronId] = useState(initialSquadron);
  const [request, setRequest] = useState("");
  const [baseRef, setBaseRef] = useState("HEAD");
  const availableDefinitions = definitions.filter(
    (definition) => definition.enabled !== false && !definition.diagnostics?.length,
  );
  const unavailableDefinitions = definitions.filter((definition) => definition.diagnostics?.length);
  const [definitionId, setDefinitionId] = useState("fh-development");
  const selectedDefinition =
    availableDefinitions.find((item) => item.id === definitionId) ?? availableDefinitions[0];
  const selectedDescription = selectedDefinition?.description;
  const selectedSquadron = eligible.some((item) => item.squadron.id === squadronId)
    ? squadronId
    : (eligible.find((item) => item.squadron.id === initialSquadron)?.squadron.id ??
      eligible[0]?.squadron.id ??
      "");
  const start = () => {
    if (!selectedDefinition) return;
    onStart({
      definitionId: selectedDefinition.id,
      squadronId: selectedSquadron,
      request,
      baseRef: baseRef.trim(),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New playbook</DialogTitle>
          <DialogDescription>
            Start a playbook in a Squadron with exactly one project.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <label className="block text-sm">
            Playbook
            <select
              aria-label="Playbook definition"
              className="mt-1 block w-full rounded border bg-background p-2"
              value={selectedDefinition?.id ?? ""}
              onChange={(event) => setDefinitionId(event.target.value)}
            >
              {availableDefinitions.map((definition) => (
                <option key={`${definition.id}:${definition.hash}`} value={definition.id}>
                  {definition.title ?? definition.id}
                </option>
              ))}
            </select>
            {selectedDescription ? (
              <span className="mt-1 block text-muted-foreground">{selectedDescription}</span>
            ) : null}
          </label>
          {unavailableDefinitions.length ? (
            <details
              open={availableDefinitions.length === 0}
              className="text-sm text-muted-foreground"
            >
              <summary>Unavailable playbooks</summary>
              <ul className="mt-2 list-disc ps-5">
                {unavailableDefinitions.map((definition) => (
                  <li key={`${definition.id}:${definition.hash || definition.source}`}>
                    {definition.title ?? definition.id}: {definition.diagnostics?.join(" ")}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {loading ? (
            <p className="rounded border p-3 text-sm">Loading Squadrons…</p>
          ) : error ? (
            <p role="alert" className="rounded border border-destructive p-3 text-sm">
              Squadrons unavailable: {error}
            </p>
          ) : eligible.length ? (
            <label className="block text-sm">
              Squadron
              <select
                aria-label="Playbook Squadron"
                className="mt-1 block w-full rounded border bg-background p-2"
                value={selectedSquadron}
                onChange={(event) => setSquadronId(event.target.value)}
              >
                {eligible.map((item) => (
                  <option key={item.squadron.id} value={item.squadron.id}>
                    {item.squadron.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="rounded border p-3 text-sm">
              No eligible Squadron has exactly one project. Create or update a Squadron before
              starting a playbook.
            </p>
          )}
          {!loading && !error && squadrons.some((item) => item.projectIds.length !== 1) && (
            <details className="text-sm text-muted-foreground">
              <summary>Why are some Squadrons unavailable?</summary>
              <ul className="mt-2 list-disc ps-5">
                {squadrons
                  .filter((item) => item.projectIds.length !== 1)
                  .map((item) => (
                    <li key={item.squadron.id}>
                      {item.squadron.name}:{" "}
                      {item.projectIds.length === 0
                        ? "no project"
                        : `${item.projectIds.length} projects`}
                    </li>
                  ))}
              </ul>
            </details>
          )}
          <label className="block text-sm">
            Base ref
            <Input
              aria-label="Base ref"
              value={baseRef}
              onChange={(event) => setBaseRef(event.target.value)}
            />
          </label>
          <label className="block text-sm">
            Request
            <Textarea
              aria-label="Playbook request"
              className="mt-1 min-h-32"
              placeholder="Describe the change and acceptance criteria"
              value={request}
              onChange={(event) => setRequest(event.target.value)}
            />
          </label>
        </DialogPanel>
        <DialogFooter>
          <Button
            disabled={
              pending ||
              !selectedDefinition ||
              !selectedSquadron ||
              !request.trim() ||
              !baseRef.trim()
            }
            onClick={start}
          >
            {pending ? "Starting…" : "Start playbook"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

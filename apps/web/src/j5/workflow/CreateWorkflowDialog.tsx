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

export function CreateWorkflowDialog({
  open,
  onOpenChange,
  squadrons,
  initialSquadron,
  pending,
  loading,
  error,
  onStart,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly squadrons: readonly ManagedSquadron[];
  readonly initialSquadron: string;
  readonly pending: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onStart: (input: {
    readonly squadronId: string;
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
  const selectedSquadron = eligible.some((item) => item.squadron.id === squadronId)
    ? squadronId
    : (eligible.find((item) => item.squadron.id === initialSquadron)?.squadron.id ??
      eligible[0]?.squadron.id ??
      "");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New workflow</DialogTitle>
          <DialogDescription>
            Start a deterministic development workflow in a Squadron with exactly one project.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
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
                aria-label="Workflow Squadron"
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
              starting a workflow.
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
            Development request
            <Textarea
              aria-label="Development request"
              className="mt-1 min-h-32"
              placeholder="Describe the change and acceptance criteria"
              value={request}
              onChange={(event) => setRequest(event.target.value)}
            />
          </label>
        </DialogPanel>
        <DialogFooter>
          <Button
            disabled={pending || !selectedSquadron || !request.trim() || !baseRef.trim()}
            onClick={() =>
              onStart({ squadronId: selectedSquadron, request, baseRef: baseRef.trim() })
            }
          >
            {pending ? "Starting…" : "Start workflow"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

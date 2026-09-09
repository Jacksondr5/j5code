import type { RunDetail } from "@j5/workflow-contracts";
import { useCallback, useRef, useState } from "react";

import { toastManager } from "../../components/ui/toast";
import { useSquadronDirectory } from "../squadron/SquadronDirectory";
import { mutateRun } from "./client";
import { refreshWorkflowQueries } from "./queries";

export type CreateWorkflowInput = { squadronId: string; request: string; baseRef: string };
export type CommandAttempt = { payload: string; commandId: string };

export function commandAttemptFor(
  current: CommandAttempt | null,
  payload: string,
  randomUUID: () => string,
): CommandAttempt {
  return current?.payload === payload ? current : { payload, commandId: randomUUID() };
}

export function useCreateWorkflow(onCreated: (run: RunDetail) => void) {
  const [open, setOpenState] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [pending, setPending] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const attempt = useRef<CommandAttempt | null>(null);
  const directory = useSquadronDirectory(hasOpened);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    if (next) setHasOpened(true);
  }, []);

  const start = useCallback(
    async (input: CreateWorkflowInput) => {
      const body = {
        definitionId: "fh-development",
        squadronId: input.squadronId,
        expectedRevision: 0,
        request: input.request,
        baseRef: input.baseRef,
        evidence: [],
      };
      const payload = JSON.stringify({ path: "", body });
      attempt.current = commandAttemptFor(attempt.current, payload, () =>
        window.crypto.randomUUID(),
      );
      setPending(true);
      setMutationError(null);
      try {
        const run = await mutateRun("", { ...body, commandId: attempt.current.commandId });
        attempt.current = null;
        setOpenState(false);
        toastManager.add({
          type: "success",
          title: "Workflow accepted; automated work is starting",
        });
        refreshWorkflowQueries();
        onCreated(run);
      } catch (cause) {
        const message = String(cause);
        setMutationError(message);
        toastManager.add({
          type: "error",
          title: "Workflow creation failed",
          description: message,
        });
      } finally {
        setPending(false);
      }
    },
    [onCreated],
  );

  return {
    open,
    setOpen,
    squadrons: directory.squadrons,
    squadronsLoading: hasOpened && directory.status === "loading",
    squadronError: directory.status === "error" ? directory.error : null,
    pending,
    mutationError,
    start,
  };
}

import type { RunDetail, PlaybookDefinitionPresentation } from "@j5/playbook-contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { toastManager } from "../../components/ui/toast";
import { useSquadronDirectory } from "../squadron/SquadronDirectory";
import { listPlaybookDefinitions, mutateRun } from "./client";
import { refreshPlaybookQueries } from "./queries";

export type CreatePlaybookInput = {
  definitionId: string;
  squadronId: string;
  request: string;
  baseRef: string;
};
export type CommandAttempt = { payload: string; commandId: string };

export function commandAttemptFor(
  current: CommandAttempt | null,
  payload: string,
  randomUUID: () => string,
): CommandAttempt {
  return current?.payload === payload ? current : { payload, commandId: randomUUID() };
}

export function useCreatePlaybook(onCreated: (run: RunDetail) => void) {
  const [open, setOpenState] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [pending, setPending] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [definitions, setDefinitions] = useState<readonly PlaybookDefinitionPresentation[]>([]);
  const attempt = useRef<CommandAttempt | null>(null);
  const directory = useSquadronDirectory(hasOpened);
  useEffect(() => {
    if (!hasOpened) return;
    void listPlaybookDefinitions()
      .then(setDefinitions)
      .catch((cause) => setMutationError(String(cause)));
  }, [hasOpened]);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    if (next) setHasOpened(true);
  }, []);

  const start = useCallback(
    async (input: CreatePlaybookInput) => {
      const body = {
        definitionId: input.definitionId,
        squadronId: input.squadronId,
        expectedRevision: 0,
        request: input.request,
        baseRef: input.baseRef,
        evidence: [],
      };
      const definition = definitions.find((item) => item.id === input.definitionId);
      if (definition) {
        Object.assign(body, {
          definitionVersion: definition.version,
          definitionHash: definition.hash,
        });
      }
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
          title: "Playbook accepted; automated work is starting",
        });
        refreshPlaybookQueries();
        onCreated(run);
      } catch (cause) {
        const message = String(cause);
        setMutationError(message);
        toastManager.add({
          type: "error",
          title: "Playbook creation failed",
          description: message,
        });
      } finally {
        setPending(false);
      }
    },
    [definitions, onCreated],
  );

  return {
    open,
    setOpen,
    squadrons: directory.squadrons,
    squadronsLoading: hasOpened && directory.status === "loading",
    squadronError: directory.status === "error" ? directory.error : null,
    pending,
    mutationError,
    definitions,
    start,
  };
}

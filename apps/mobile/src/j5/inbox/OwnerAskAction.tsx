import { useAtomValue } from "@effect/atom-react";
import { ownerAskAction } from "@t3tools/client-runtime/j5/inbox";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { HumanInboxItem } from "@t3tools/contracts/j5";
import { useRef, useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { j5Environment } from "../state";
import { inboxCountQueryAtom, readInboxSources } from "./inboxSources";

/**
 * The Owner's answer to an ask that carries a server record, as on web: "Allow this once" for a
 * blocked persona launch, or "Save persona" for an agent's persona draft. Null unless this
 * connection is an Owner who may take it; a typed reply answers the ask but grants or saves nothing.
 */
export function useOwnerAskAction(
  environmentId: EnvironmentId,
  item: Pick<HumanInboxItem, "exchangeId" | "escalation" | "personaDraft">,
) {
  const mayAllow = useAtomValue(j5Environment.allowPersonaOnce.permissionAtom(environmentId));
  const maySave = useAtomValue(j5Environment.savePersonaDraft.permissionAtom(environmentId));
  const allowOnce = useAtomCommand(j5Environment.allowPersonaOnce, { reportFailure: false });
  const savePersona = useAtomCommand(j5Environment.savePersonaDraft, { reportFailure: false });
  const [pending, setPending] = useState(false);
  // A retry after a lost reply reuses its request id, so it cannot answer twice.
  const requestId = useRef<string | null>(null);
  const action = ownerAskAction(item);
  if (action === null || !(action.kind === "allow-once" ? mayAllow : maySave)) return null;

  const run = async () => {
    const clientRequestId = requestId.current ?? uuidv4();
    requestId.current = clientRequestId;
    setPending(true);
    const input = { exchangeId: item.exchangeId, clientRequestId };
    const result =
      action.kind === "allow-once"
        ? await allowOnce({ environmentId, input })
        : await savePersona({ environmentId, input });
    if (result._tag === "Success") {
      requestId.current = null;
      appAtomRegistry.refresh(inboxCountQueryAtom(environmentId));
      await readInboxSources();
    } else {
      const cause = squashAtomCommandFailure(result);
      Dialog.alert(action.failed, cause instanceof Error ? cause.message : undefined);
    }
    setPending(false);
  };

  return { label: action.label, detail: action.detail, pending, run };
}

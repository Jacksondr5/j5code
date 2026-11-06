import { useAtomValue } from "@effect/atom-react";
import { ALLOW_ONCE_LIFTS } from "@t3tools/client-runtime/j5/agent-personas";
import type { EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { randomUUID } from "../../lib/utils";
import { j5Environment } from "../state";
import { allowPersonaOnce, savePersonaDraft, type HumanInboxItem } from "./humanInboxClient";
import { notifyHumanInboxChanged } from "./humanInboxRefresh";

type Item = Pick<HumanInboxItem, "exchangeId" | "escalation" | "personaDraft">;

/** The one Owner action an ask carries, while it is still open to take. */
const actionOf = (item: Item) => {
  const { escalation, personaDraft } = item;
  if (escalation?.status === "open" && escalation.waivable !== null)
    return {
      kind: "allow-once" as const,
      label: "Allow this once",
      pendingLabel: "Allowing…",
      failed: "Could not allow it once.",
      title: `Lets ${escalation.personaId} start once on ${ALLOW_ONCE_LIFTS[escalation.waivable]}. Later launches keep its usual limits.`,
    };
  if (personaDraft?.status === "open")
    return {
      kind: "save-persona" as const,
      label: "Save persona",
      pendingLabel: "Saving…",
      failed: "Could not save the persona.",
      title:
        personaDraft.mode === "create"
          ? `Adds ${personaDraft.personaId} to this server's persona library, for everyone on it.`
          : personaDraft.overridesFolder
            ? `Saves ${personaDraft.personaId} as an override of the team persona for everyone on this server. Later team updates stay hidden until the override is removed and the team persona restored.`
            : `Saves the edit to ${personaDraft.personaId} for everyone on this server.`,
    };
  return null;
};

/**
 * The Owner's answer to an ask that carries a server record: "Allow this once" for a blocked
 * persona, or "Save persona" for an agent's persona draft. Shown only to an Owner.
 */
export function OwnerAskAction(props: {
  readonly environmentId: EnvironmentId;
  readonly item: Item;
  readonly disabled: boolean;
  readonly size: "sm" | "default";
  /** Beyond the read-change feed, which brings the answered ask to every open view. */
  readonly onDone?: () => void;
}) {
  const { environmentId, item } = props;
  const mayAllow = useAtomValue(j5Environment.allowPersonaOnce.permissionAtom(environmentId));
  const maySave = useAtomValue(j5Environment.savePersonaDraft.permissionAtom(environmentId));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A retry after a lost reply reuses its request id, so it cannot answer twice.
  const requestId = useRef<string | null>(null);
  const action = actionOf(item);
  if (action === null || !(action.kind === "allow-once" ? mayAllow : maySave)) return null;

  const run = async () => {
    const clientRequestId = requestId.current ?? randomUUID();
    requestId.current = clientRequestId;
    setPending(true);
    setError(null);
    try {
      const input = { exchangeId: item.exchangeId, clientRequestId };
      await (action.kind === "allow-once"
        ? allowPersonaOnce(environmentId, input)
        : savePersonaDraft(environmentId, input));
      requestId.current = null;
      notifyHumanInboxChanged(environmentId);
      props.onDone?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : action.failed);
    }
    setPending(false);
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {error === null ? null : (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button
        disabled={props.disabled || pending}
        onClick={() => void run()}
        size={props.size}
        title={action.title}
        type="button"
        variant="outline"
      >
        {pending ? action.pendingLabel : action.label}
      </Button>
    </div>
  );
}

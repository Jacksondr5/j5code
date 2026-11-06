import { useAtomValue } from "@effect/atom-react";
import { ALLOW_ONCE_LIFTS } from "@t3tools/client-runtime/j5/agent-personas";
import type { EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { randomUUID } from "../../lib/utils";
import { j5Environment } from "../state";
import { allowPersonaOnce, type HumanInboxItem } from "./humanInboxClient";
import { notifyHumanInboxChanged } from "./humanInboxRefresh";

/**
 * The Owner's answer to an ask escalating a blocked persona: it lets that one launch past the one
 * limit the server named. Shown only to an Owner, and only while that limit is still open to lift.
 */
export function AllowPersonaOnceButton(props: {
  readonly environmentId: EnvironmentId;
  readonly item: Pick<HumanInboxItem, "exchangeId" | "escalation">;
  readonly disabled: boolean;
  readonly size: "sm" | "default";
  /** Beyond the read-change feed, which brings the answered ask to every open view. */
  readonly onAllowed?: () => void;
}) {
  const { environmentId, item } = props;
  const mayAllow = useAtomValue(j5Environment.allowPersonaOnce.permissionAtom(environmentId));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A retry after a lost reply reuses its request id, so it cannot answer twice.
  const requestId = useRef<string | null>(null);
  const escalation = item.escalation;
  if (!mayAllow || escalation?.status !== "open" || escalation.waivable === null) return null;

  const allow = async () => {
    const clientRequestId = requestId.current ?? randomUUID();
    requestId.current = clientRequestId;
    setPending(true);
    setError(null);
    try {
      await allowPersonaOnce(environmentId, { exchangeId: item.exchangeId, clientRequestId });
      requestId.current = null;
      notifyHumanInboxChanged(environmentId);
      props.onAllowed?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not allow it once.");
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
        onClick={() => void allow()}
        size={props.size}
        title={`Lets ${escalation.personaId} start once on ${ALLOW_ONCE_LIFTS[escalation.waivable]}. Later launches keep its usual limits.`}
        type="button"
        variant="outline"
      >
        {pending ? "Allowing…" : "Allow this once"}
      </Button>
    </div>
  );
}

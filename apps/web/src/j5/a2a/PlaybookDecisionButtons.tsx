import { isOwnerAccess } from "@t3tools/client-runtime/j5/sharing";
import type { EnvironmentId } from "@t3tools/contracts";
import { PLAYBOOK_PERSONA_EXCHANGE_PREFIX } from "@t3tools/contracts/j5";
import { useConnectionAccess } from "../sharing/access";
import { Button } from "../../components/ui/button";

export function PlaybookDecisionButtons(props: {
  readonly environmentId: EnvironmentId;
  readonly exchangeId: string;
  readonly reason: string;
  readonly disabled: boolean;
  readonly submit: (answer: string) => void;
}) {
  const access = useConnectionAccess(props.environmentId);
  if (props.exchangeId.startsWith(PLAYBOOK_PERSONA_EXCHANGE_PREFIX) && !isOwnerAccess(access))
    return (
      <span className="text-xs text-muted-foreground">
        An environment Owner can answer this request.
      </span>
    );
  const reason = props.reason.trim();
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={props.disabled}
        onClick={() => props.submit(reason ? `Decline: ${reason}` : "Decline")}
      >
        Decline
      </Button>
      <Button
        type="button"
        size="sm"
        disabled={props.disabled}
        onClick={() => props.submit("Approve")}
      >
        Approve
      </Button>
    </>
  );
}

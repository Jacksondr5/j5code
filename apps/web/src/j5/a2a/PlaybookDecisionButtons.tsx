import { Button } from "../../components/ui/button";

export function PlaybookDecisionButtons(props: {
  readonly reason: string;
  readonly disabled: boolean;
  readonly submit: (answer: string) => void;
}) {
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

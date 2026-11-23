import { CircleAlertIcon } from "lucide-react";

import { Alert, AlertDescription } from "../../components/ui/alert";

/** Why an answer did not send or a file was refused, under its ask, drawn as upstream's thread error banner draws one. */
export function AnswerErrorAlert(props: { readonly message: string }) {
  return (
    <Alert variant="error">
      <CircleAlertIcon />
      <AlertDescription>{props.message}</AlertDescription>
    </Alert>
  );
}

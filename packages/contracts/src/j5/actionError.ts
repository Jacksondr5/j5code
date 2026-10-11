import * as Schema from "effect/Schema";

/**
 * A J5 client action the server refused or could not finish. `code` is the refusal's stable name
 * (`CrewProposalNotOpenError`, `peer_unreachable`, ...) and `message` is what the person reads.
 */
export class J5ActionError extends Schema.TaggedError<J5ActionError>()("J5ActionError", {
  code: Schema.String,
  message: Schema.String,
}) {}

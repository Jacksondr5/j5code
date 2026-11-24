import * as ThreadRegistration from "./ThreadRegistration.ts";
import * as A2ALedger from "./LedgerService.ts";
import * as A2ASendService from "./SendService.ts";
import type { McpThreadInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ParticipantDirectoryRow } from "./contracts.ts";
class J5AgentToolStateError extends Schema.TaggedError<J5AgentToolStateError>()(
  "J5AgentToolStateError",
  { state: Schema.String, nextCommand: Schema.String },
) {
  override get message(): string {
    return `${this.state} ${this.nextCommand}`;
  }
}

export const stateError = (state: string, nextCommand: string) =>
  new J5AgentToolStateError({ state, nextCommand });

/** A linked server's refusal, or the link's own failure, keeping its code as the tool failure's. */
export class J5PeerToolError extends Schema.TaggedError<J5PeerToolError>()("J5PeerToolError", {
  code: Schema.String,
  message: Schema.String,
}) {}

/** A refused persona launch, whose code (`persona_disabled` and so on) is the tool failure's. */
export class J5PersonaBlockedError extends Schema.TaggedError<J5PersonaBlockedError>()(
  "J5PersonaBlockedError",
  { code: Schema.String, state: Schema.String, nextCommand: Schema.String },
) {
  override get message(): string {
    return `${this.state} ${this.nextCommand}`;
  }
}

type AgentDirectoryRow = ParticipantDirectoryRow & {
  readonly participant: Extract<ParticipantDirectoryRow["participant"], { readonly kind: "agent" }>;
};

export const resolveCallerMembership = Effect.fn("j5.a2a.mcp.resolveCallerMembership")(function* (
  scope: McpThreadInvocationScope,
) {
  const directory = yield* (yield* A2ASendService.A2ASendService)
    .listParticipants(scope.thread.threadId)
    .pipe(
      Effect.mapError((error) =>
        stateError(
          `Caller thread ${scope.thread.threadId} has no usable membership in its project: ${error instanceof Error ? error.message : String(error)}.`,
          "Call j5_list_participants to inspect current membership before retrying.",
        ),
      ),
    );
  const memberships = directory.filter(
    (row): row is AgentDirectoryRow =>
      row.participant.kind === "agent" && row.participant.threadId === scope.thread.threadId,
  );
  if (memberships.length === 0) {
    return yield* stateError(
      `Caller membership is missing for thread ${scope.thread.threadId}.`,
      "Call j5_list_participants to inspect current membership before retrying.",
    );
  }
  if (memberships.length !== 1) {
    return yield* stateError(
      `Caller membership for thread ${scope.thread.threadId} is ambiguous across projects ${memberships.map((row) => row.projectId).join(", ")}.`,
      "Call j5_list_participants to inspect current membership before retrying.",
    );
  }
  return memberships[0]!;
});

export const preflightSpawnCaller = Effect.fn("j5.a2a.mcp.preflightSpawnCaller")(function* (
  scope: McpThreadInvocationScope,
) {
  const ledger = yield* A2ALedger.A2ALedger;
  // A thread from before every thread registered at creation registers here, on its first call.
  const home = yield* (yield* ThreadRegistration.ThreadRegistration)
    .ensureRegistered(scope.thread.threadId)
    .pipe(
      Effect.mapError((error) =>
        stateError(
          `Caller thread ${scope.thread.threadId} could not be registered in its project: ${error instanceof Error ? error.message : String(error)}.`,
          "Retry j5_spawn_agent; if it keeps failing, tell the human.",
        ),
      ),
    );
  if (home === null) {
    return yield* stateError(
      `Caller thread ${scope.thread.threadId} is a Subagent and is not an agent-to-agent participant.`,
      "Return your result to the agent that started you; it can spawn agents.",
    );
  }
  const project = yield* ledger
    .readProjectLedger(home.projectId)
    .pipe(
      Effect.mapError((error) =>
        stateError(
          `Caller thread ${scope.thread.threadId} is registered in project ${home.projectId}, but that project's ledger is unavailable: ${error instanceof Error ? error.message : String(error)}.`,
          "Tell the human before retrying j5_spawn_agent.",
        ),
      ),
    );
  const membership = yield* resolveCallerMembership(scope);
  if (membership.projectId !== home.projectId || membership.participantId !== home.participantId) {
    return yield* stateError(
      `Caller thread ${scope.thread.threadId} is registered as ${home.projectId}/${home.participantId}, but its current membership is ${membership.projectId}/${membership.participantId}.`,
      "Call j5_list_participants to inspect current membership, then ask the human to repair the mismatch before retrying j5_spawn_agent.",
    );
  }
  return { ...membership, project };
});

import { CommandId, MessageId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { AgentHandoffNudgeQueue, type AgentHandoffNudge } from "./agentHandoffNudgeQueue.ts";
import { agentHandoffLogicalPath } from "./agentPersonaArtifacts.ts";

export const agentHandoffNudgeText = (nudge: AgentHandoffNudge) =>
  `Your run ended without the declared ${nudge.artifact} handoff. Write it now with write_artifact to exactly \`${nudge.path}\` (it will appear as \`${agentHandoffLogicalPath(nudge.path)}\`), covering the required contents from your instructions, then finish. This is the only reminder; a run that ends without it is recorded as a missing handoff.`;

/**
 * Drains the nudge queue where ThreadManagement is available and sends the one follow-up
 * message into the saved agent's own thread. Ids derive from the run so a redelivery of the
 * same finalization cannot start a second turn.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const nudges = yield* AgentHandoffNudgeQueue;
    const threads = yield* ThreadManagementService;
    const deliver = Effect.fn("j5.agentHandoffNudgeWorker.deliver")(function* (
      nudge: AgentHandoffNudge,
    ) {
      yield* threads.sendToThread({
        projectId: nudge.projectId,
        commandId: CommandId.make(`agent-handoff-nudge:${nudge.runId}`),
        threadId: nudge.threadId,
        messageId: MessageId.make(`agent-handoff-nudge:${nudge.runId}`),
        text: agentHandoffNudgeText(nudge),
        attachments: [],
        mode: "queue",
        createdBy: "system",
        creationSource: "server",
      });
    });
    yield* Queue.take(nudges).pipe(
      Effect.flatMap((nudge) =>
        deliver(nudge).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("j5.agent-handoff.nudge-failed", {
              cause,
              threadId: nudge.threadId,
            }),
          ),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);

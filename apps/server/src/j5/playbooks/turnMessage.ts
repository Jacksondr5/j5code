import * as Effect from "effect/Effect";

import { readCaller } from "../../mcp/threadAccess.ts";

/** The initiating message of this thread's active turn, when the platform has one. */
export const turnMessage = Effect.gen(function* () {
  const { caller, threads, scope } = yield* readCaller();
  const runId = caller?.activeRunId;
  if (!caller || !runId || scope.thread?.subagent) return;
  const records = yield* threads
    .getThreadRecords(caller.id, ["runs", "messages"], {
      runIds: [runId],
      messageRunIds: [runId],
      messageRoles: ["user"],
    })
    .pipe(Effect.orElseSucceed(() => undefined));
  const run = records?.runs.find((record) => record.id === runId);
  return records?.messages.find((message) => message.id === run?.userMessageId);
});

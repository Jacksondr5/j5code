import { PLAYBOOK_NAME_PATTERN } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";

import { readCaller } from "../../mcp/threadAccess.ts";
import { playbookError } from "./definition.ts";

export const authorizeScheduledPlaybookStart = Effect.fn("Playbook.authorizeScheduledStart")(
  function* (name: string) {
    const { caller, threads } = yield* readCaller();
    const activeRunId = caller?.activeRunId;

    const unavailable = playbookError(
      "playbook_turn_unavailable",
      "The message that started this turn could not be verified. Retry from an active turn.",
    );
    if (caller === undefined || activeRunId == null) return yield* unavailable;
    const { runs, messages } = yield* threads
      .getThreadRecords(caller.id, ["runs", "messages"], {
        runIds: [activeRunId],
        messageRunIds: [activeRunId],
        messageRoles: ["user"],
      })
      .pipe(Effect.mapError(() => unavailable));
    const run = runs.find((candidate) => candidate.id === activeRunId);
    const origin = messages.find((message) => message.id === run?.userMessageId);
    if (origin === undefined) return yield* unavailable;
    if (origin.scheduledTaskId === undefined) return;

    const stem = name.replace(/\.yaml$/, "");
    const prompt = origin.scheduledTaskPrompt;
    if (
      prompt !== undefined &&
      PLAYBOOK_NAME_PATTERN.test(stem) &&
      new RegExp(`(?<![\\p{L}\\p{N}_:@-])(?:@playbook:)?${stem}(?![\\p{L}\\p{N}_-])`, "iu").test(
        prompt,
      )
    ) {
      return;
    }
    return yield* playbookError(
      "scheduled_playbook_not_named",
      prompt === undefined
        ? `This scheduled turn has no recorded task prompt. Include @playbook:${stem} in the task prompt and run it again.`
        : `This scheduled task's prompt does not name ${stem}. Include @playbook:${stem} in the task prompt before starting it on a scheduled turn.`,
    );
  },
);

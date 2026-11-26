import * as Effect from "effect/Effect";

import { storedPrompt } from "../sharing/scheduledRuns.ts";
import { playbookError, storageError } from "./definition.ts";

export const authorizeScheduledStart = Effect.fn("Playbook.authorizeScheduledStart")(function* (
  taskId: string,
  name: string,
) {
  const prompt = yield* storedPrompt(taskId);
  const stem = name.replace(/\.yaml$/, "");
  const names = prompt?.match(/[\p{L}\p{N}_-]+/gu);
  if (!names?.includes(stem))
    return yield* playbookError(
      "scheduled_playbook_not_named",
      `The scheduled task's prompt must name the playbook, for example @playbook:${stem}.`,
    );
}, Effect.mapError(storageError));

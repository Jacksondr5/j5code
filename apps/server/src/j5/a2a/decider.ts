import type { AppendCommEventCommand, StoredCommEvent } from "./contracts.ts";

export type PendingCommEvent = Omit<StoredCommEvent, "seq">;

/** Pure command decision. Persistence assigns the per-project sequence. */
export const decideAppendCommEvent = (
  command: AppendCommEventCommand,
): readonly [PendingCommEvent] => [
  {
    projectId: command.projectId,
    ...command.event,
  },
];

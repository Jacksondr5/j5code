import type { AppendCommEventCommand, StoredCommEvent } from "./contracts.ts";

export type PendingCommEvent = Omit<StoredCommEvent, "seq">;

/** Pure command decision. Persistence assigns the per-epic sequence. */
export const decideAppendCommEvent = (
  command: AppendCommEventCommand,
): readonly [PendingCommEvent] => [
  {
    epicId: command.epicId,
    ...command.event,
  },
];

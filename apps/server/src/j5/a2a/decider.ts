import type { AppendCommEventCommand, StoredCommEvent } from "./contracts.ts";

export type PendingCommEvent = Omit<StoredCommEvent, "seq">;

/** Pure command decision. Persistence assigns the per-squadron sequence. */
export const decideAppendCommEvent = (
  command: AppendCommEventCommand,
): readonly [PendingCommEvent] => [
  {
    squadronId: command.squadronId,
    ...command.event,
  },
];

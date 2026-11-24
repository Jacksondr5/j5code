/**
 * Believable results for J5's own tools when a case does not mock them, in the shape of their
 * success schemas in apps/server/src/j5/a2a/mcp/tools.ts. Thread links use the same environment
 * and numbering as upstream's defaults, so a J5 case checks a spawned agent's link the way an
 * upstream case checks a launched thread's.
 */
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";

import type { Sample } from "./upstream.ts";

const EVAL_ENVIRONMENT_ID = EnvironmentId.make("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
const SELF = "participant-self";
const PROJECT = { project_id: "11111111-1111-4111-8111-aaaaaaaaaaaa", project_title: "app" };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const linkTo = (threadId: string) =>
  formatThreadLink({ environmentId: EVAL_ENVIRONMENT_ID, threadId: ThreadId.make(threadId) });
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const participantRow = (row: {
  readonly id: string;
  readonly kind: "agent" | "person";
  readonly name: string;
  readonly threadId: string | null;
  readonly self?: boolean;
}) => ({
  ...PROJECT,
  participant_id: row.id,
  participant: { kind: row.kind, display_name: row.name },
  self: row.self === true,
  archived: false,
  can_receive_message: true,
  can_open_exchange: true,
  accepts_urgency: row.kind === "person",
  thread_id: row.threadId,
  link: row.threadId === null ? null : linkTo(row.threadId),
  provenance: { kind: "not-applicable" },
  placement_parent_id: null,
  display_name: row.name,
});

/** J5's result for one of its own tools, or undefined for a tool this file does not cover. */
export const j5Default = (
  sample: Sample,
  name: string,
  input: Readonly<Record<string, unknown>>,
): unknown => {
  switch (name) {
    case "j5_spawn_agent": {
      const n = sample.nextTask++;
      return {
        participant_id: `participant-${n}`,
        thread_id: uuid(n),
        link: linkTo(uuid(n)),
        run_id: `run-${n}`,
        project_id: typeof input.project_id === "string" ? input.project_id : PROJECT.project_id,
        project_title: typeof input.project_id === "string" ? "project" : PROJECT.project_title,
        placement: {
          placement_parent_id: typeof input.project_id === "string" ? null : SELF,
          provenance: {
            kind: "spawned-by",
            spawned_by_participant_id: SELF,
            source: "j5_spawn",
          },
        },
      };
    }
    case "j5_send_message": {
      const n = sample.nextTask++;
      const expectReply = input.expect_reply === true;
      return {
        messageId: `message-${n}`,
        exchangeId: expectReply ? `exchange-${n}` : null,
        exchangeState: expectReply ? "open" : "none",
        joinedExistingExchange: false,
        durableAtSeq: n,
        note: `Delivered to ${String(input.to)}.${expectReply ? " Its reply will arrive as a message." : ""}`,
      };
    }
    case "j5_list_participants": {
      const participants = [
        participantRow({
          id: SELF,
          kind: "agent",
          name: "This agent",
          threadId: uuid(0),
          self: true,
        }),
        participantRow({
          id: "participant-user",
          kind: "person",
          name: "Acme Dev",
          threadId: null,
        }),
      ];
      return {
        participants,
        next_cursor: null,
        total: participants.length,
        unread_peer_count: 0,
      };
    }
    case "j5_list_personas":
      return { diagnostics: [], personas: [] };
    case "j5_propose_crew":
    case "j5_request_crew_member":
      return {
        proposal_id: `proposal-${sample.nextTask++}`,
        status: "open",
        approval_mode: "human",
        crew_instance_id:
          isRecord(input) && typeof input.crew_instance_id === "string"
            ? input.crew_instance_id
            : null,
        members: [],
      };
    default:
      return undefined;
  }
};

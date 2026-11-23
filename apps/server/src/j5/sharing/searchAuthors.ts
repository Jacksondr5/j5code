import type { OrchestrationThreadSearchMatch } from "@t3tools/contracts";
import type { ThreadSearchAuthor } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { ParticipantId } from "../a2a/contracts.ts";
import { PersonAccess, PersonAccessStorageError } from "./PersonAccess.ts";
import { type MessageOrigin, messageOriginColumns, typedByFirstOwner } from "./messageStamps.ts";

const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/**
 * Who typed each person-role message Cmd+K found, as `viewer` (`null` for a session with no
 * person) may know them. A hit is always a message of its own thread, never one a fork inherits,
 * so its record names its writer as the thread's timeline does (`threadAuthors`).
 */
export const makeSearchAuthors = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const people = yield* PersonAccess;

  return Effect.fn("j5.sharing.searchAuthors.label")(
    function* <Match extends OrchestrationThreadSearchMatch>(
      viewer: ParticipantId | null,
      matches: ReadonlyArray<Match>,
    ) {
      const ids = matches.flatMap((match) =>
        match.source === "user" && match.messageId !== undefined ? [match.messageId] : [],
      );
      if (ids.length === 0) return matches;
      const rows = yield* sql<
        MessageOrigin & {
          readonly message_id: string;
          readonly person_id: string | null;
          readonly display_name: string | null;
        }
      >`
        SELECT message.message_id, author.person_id, author.display_name,
          ${sql.literal(messageOriginColumns("message"))}
        FROM orchestration_v2_projection_messages AS message
        LEFT JOIN j5_a2a_message_author AS author
          ON author.thread_id = message.thread_id AND author.message_id = message.message_id
        WHERE message.message_id IN (SELECT value FROM json_each(${encodeIds(ids)}))
      `;
      // The first owner, read once and only for a message typed before its thread was shared.
      const ownerAsTold = yield* Effect.cached(
        Effect.gen(function* () {
          const owner = yield* people.firstOwner;
          if (owner.personId === viewer) return { _tag: "you" } as const;
          const told =
            viewer === null ||
            (yield* people.participantVisible(viewer, {
              participantId: owner.personId,
              threadId: null,
            }));
          return { _tag: "person", name: told ? owner.displayName : null } as const;
        }),
      );
      const authors = new Map<string, ThreadSearchAuthor>();
      for (const row of rows) {
        if (row.person_id !== null) {
          authors.set(
            row.message_id,
            row.person_id === viewer ? { _tag: "you" } : { _tag: "person", name: row.display_name },
          );
        } else if (typedByFirstOwner(row)) {
          authors.set(row.message_id, yield* ownerAsTold);
        }
      }
      return matches.map((match) => {
        const author = match.messageId === undefined ? undefined : authors.get(match.messageId);
        return author === undefined ? match : { ...match, author };
      });
    },
    Effect.mapError((cause) =>
      cause._tag === "PersonAccessStorageError"
        ? cause
        : new PersonAccessStorageError({ operation: "read who wrote search hits", cause }),
    ),
  );
});

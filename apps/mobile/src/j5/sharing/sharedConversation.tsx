import { useAtomValue } from "@effect/atom-react";
import {
  authorIndex,
  isSettledPrompt,
  NO_SHARED_MESSAGES_SEEN,
  observeSharedMessages,
  sharedQueuedRuns,
  type ThreadAuthorIndex,
} from "@t3tools/client-runtime/j5/shared-conversation";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ThreadAuthors } from "@t3tools/contracts/j5";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { appAtomRegistry } from "../../state/atom-registry";
import { j5Sharing } from "./guestAccess";
import { presentSharedConversationFeed } from "./sharedConversationFeed";

const NO_RECORD = Atom.make(AsyncResult.initial(false)) as ReturnType<
  typeof j5Sharing.threadAuthors
>;
const NO_CHANGES = Atom.make(AsyncResult.initial(false)) as ReturnType<
  typeof j5Sharing.threadAuthorsChanges
>;

function useThreadAuthorsResult(environmentId: EnvironmentId | null, threadId: ThreadId | null) {
  const result = useAtomValue(
    environmentId === null || threadId === null
      ? NO_RECORD
      : j5Sharing.threadAuthors({ environmentId, input: { threadId } }),
  );
  const record: ThreadAuthors | null = Option.getOrNull(AsyncResult.value(result));
  return {
    record,
    failed: AsyncResult.isFailure(result),
    readAt: result._tag === "Success" ? result.timestamp : null,
  };
}

/**
 * The thread's record as its timeline last read it, by message and by prompt. Rows, the queue and
 * the work log read it and ask nothing; the timeline's own read keeps it current.
 */
export function useThreadAuthorIndex(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ThreadAuthorIndex {
  return authorIndex(useThreadAuthorsResult(environmentId, threadId).record);
}

/** The queue's rows with the words their authors typed (Shared conversations AC14). */
export function useSharedQueuedRuns<
  Queued extends { readonly run: { readonly userMessageId: string }; readonly text: string },
>(environmentId: EnvironmentId, threadId: ThreadId, queued: ReadonlyArray<Queued>) {
  return sharedQueuedRuns(useThreadAuthorsResult(environmentId, threadId), queued);
}

/**
 * Shared conversations AC16 for the native timeline (`presentSharedConversationFeed`), from the
 * record of who sent each message, read again whenever the server says it changed.
 */
export function useSharedConversationFeed(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
  feed: ReadonlyArray<ThreadFeedEntry>,
): ReadonlyArray<ThreadFeedEntry> {
  const target =
    environmentId === null || threadId === null ? null : { environmentId, input: { threadId } };
  const query = target === null ? NO_RECORD : j5Sharing.threadAuthors(target);
  const { record, failed, readAt } = useThreadAuthorsResult(environmentId, threadId);
  const changes = useAtomValue(
    target === null ? NO_CHANGES : j5Sharing.threadAuthorsChanges(target),
  );
  const revision = Option.getOrNull(AsyncResult.value(changes))?.revision;
  // oxlint-disable-next-line t3code/react-effect-budget -- rereads message authors when the server's change counter moves.
  useEffect(() => {
    if (revision !== undefined && revision > 0) appAtomRegistry.refresh(query);
  }, [query, revision]);

  const [stored, setStored] = useState(NO_SHARED_MESSAGES_SEEN);
  const seen = observeSharedMessages(
    stored,
    feed.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
    Date.now,
  );
  if (seen !== stored) setStored(seen);

  const { feed: shown, pendingKey } = presentSharedConversationFeed({
    feed,
    record,
    failed,
    readAt,
    seen,
  });
  // oxlint-disable-next-line t3code/react-effect-budget -- asks once more about a message waiting on its author, in case the change feed is slow.
  useEffect(() => {
    if (pendingKey !== "") appAtomRegistry.refresh(query);
  }, [pendingKey, query]);

  return shown;
}

/**
 * Who answered one of the agent's prompts, after the prompt's own line: " · answered by Priya".
 * Nothing for a prompt nobody is recorded as answering, or one still open (AC10).
 */
export function PromptAnsweredBy(props: {
  readonly environmentId: EnvironmentId;
  readonly item: { readonly threadId: ThreadId };
}) {
  const { answers } = useThreadAuthorIndex(props.environmentId, props.item.threadId);
  const answer = isSettledPrompt(props.item) ? answers.get(props.item.requestId) : undefined;
  if (answer === undefined) return null;
  return (
    <Text className="text-foreground-subtle">
      {` · answered by ${answer.you ? "you" : (answer.name ?? "someone")}`}
    </Text>
  );
}

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  j5MessageAuthorName,
  j5SenderThreadRef,
  type ParticipantIdentities,
} from "@t3tools/client-runtime/j5/participant-identity";
import { authorIndex } from "@t3tools/client-runtime/j5/shared-conversation";
import {
  participantIdsForJ5UserMessage,
  resolveJ5UserMessagePresentation,
  type J5UserMessageInput,
} from "@t3tools/client-runtime/j5/user-message";
import type { EnvironmentId, ScheduledTaskId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import { useQuietThreadShell } from "../../state/entities";
import { useConnectionAccess } from "../sharing/access";
import { useThreadAuthorsValue } from "../sharing/sharedConversation";
import { useParticipantIdentities } from "./ParticipantIdentitiesClient";
import { J5SenderLine } from "./ThreadA2ARenderer";

type QueuedMessage = Omit<J5UserMessageInput, "scheduledTaskId"> & {
  readonly id: string;
  readonly scheduledTaskId?: ScheduledTaskId | undefined;
  readonly senderThreadId?: string | undefined;
};

// A queued message spells an absent task as `undefined`, which the classifier's input leaves out.
const classifierInput = ({ scheduledTaskId, ...message }: QueuedMessage): J5UserMessageInput =>
  scheduledTaskId === undefined ? message : { ...message, scheduledTaskId };

/** Who sent a queued message, read as the timeline reads it (D38). */
export interface J5QueuedSender {
  readonly message: QueuedMessage;
  readonly threadRef: ScopedThreadRef;
  /** Upstream's presentation with J5's reading of who is speaking on top. */
  readonly presentation: ReturnType<typeof resolveJ5UserMessagePresentation>;
  /** Anyone but the reader sits on the left, as in the timeline. */
  readonly side: "left" | "right";
  /** The words J5 took out of an envelope; null leaves the row's own text. */
  readonly text: string | null;
  readonly identities: ParticipantIdentities;
}

/**
 * One identity read for a thread's queue, and a reader that places each queued message the way
 * the timeline places it once sent: a J5 delivery folds under its participant's name.
 */
export function useJ5QueuedSenders(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messages: ReadonlyArray<QueuedMessage | undefined>,
) {
  const access = useConnectionAccess(environmentId);
  const viewerParticipantId = access?.kind === "person" ? access.personId : null;
  const identities = useParticipantIdentities(
    environmentId,
    messages.flatMap((message) =>
      message ? participantIdsForJ5UserMessage(classifierInput(message)) : [],
    ),
  );
  const { authors } = authorIndex(useThreadAuthorsValue(environmentId, threadId));
  const threadRef = scopeThreadRef(environmentId, threadId);
  return (message: QueuedMessage | undefined): J5QueuedSender | null => {
    if (message === undefined) return null;
    const presentation = resolveJ5UserMessagePresentation(classifierInput(message), {
      viewerParticipantId,
    });
    const sharedAuthor = authors.get(message.id);
    const otherPerson = sharedAuthor !== undefined && !sharedAuthor.you;
    return {
      message,
      threadRef,
      presentation,
      // Only the viewer's own messages sit on the right (register D38).
      side: otherPerson
        ? "left"
        : (presentation.j5?.side ??
          (presentation.attribution !== null || message.createdBy === "system" ? "left" : "right")),
      text: presentation.j5?.unwrapped ? presentation.text : null,
      identities,
    };
  };
}

/** The line above a queued message: its participant's name and Exchange badge or tag. */
export function J5QueuedSenderLine({ sender }: { readonly sender: J5QueuedSender }) {
  const j5 = sender.presentation.j5;
  const senderThreadRef = j5SenderThreadRef({
    environmentId: sender.threadRef.environmentId,
    presentation: j5,
    messageSenderThreadId: sender.message.senderThreadId,
    participantThreads: sender.identities.threads,
  });
  // A peer's thread opens only from a client connected to that peer, and only if the person can
  // see it there; the client's own thread list answers both.
  const senderThread = useQuietThreadShell(j5?.group === "participant" ? senderThreadRef : null);
  return (
    <J5SenderLine
      message={sender.message}
      presentation={{
        j5,
        authorName: j5MessageAuthorName({
          presentation: j5,
          participantLabels: sender.identities.labels,
          senderThreadTitle: senderThread?.title,
        }),
        senderThreadRef: senderThread === null ? null : senderThreadRef,
      }}
      threadRef={sender.threadRef}
      participantLabels={sender.identities.labels}
    />
  );
}

import {
  presentCrewContext,
  presentCrewNotice,
  type CrewNoticePresentation,
} from "@t3tools/client-runtime/j5/crew-notices";
import {
  nameJ5NoticeParticipants,
  type ParticipantIdentities,
} from "@t3tools/client-runtime/j5/participant-identity";
import {
  firstLine,
  presentJ5UserMessage,
  resolveJ5UserMessagePresentation,
  type J5NoticeKind,
  type J5PromptKind,
  type J5UserMessageInput,
} from "@t3tools/client-runtime/j5/user-message";
import type { EnvironmentId } from "@t3tools/contracts";
import type { MessageAuthor } from "@t3tools/contracts/j5";

/**
 * What every J5 row in one thread's timeline reads: the reader, the identity read's names, and
 * who sent each message of a shared conversation.
 */
export interface J5Timeline extends ParticipantIdentities {
  readonly environmentId: EnvironmentId;
  readonly viewerParticipantId: string | null;
  readonly sharedAuthors: ReadonlyMap<string, MessageAuthor>;
}

/**
 * Upstream's user-message presentation with J5's reading on top (the shared classifier): the
 * letter without its envelope, `"agent"` for every participant so it folds, which side it sits
 * on, and the folded row's preview where J5 read the message. A playbook step or a native
 * question is `"automation"`, so upstream's Automation row draws it with J5's `prompt` heading.
 */
export function resolveJ5FeedMessage(message: J5UserMessageInput, timeline: J5Timeline) {
  const presentation = resolveJ5UserMessagePresentation(message, {
    viewerParticipantId: timeline.viewerParticipantId,
  });
  const j5 = presentation.j5;
  const sharedAuthor =
    j5?.group === "person" && !j5.viaInbox && message.id !== undefined
      ? timeline.sharedAuthors.get(String(message.id))
      : undefined;
  const prompt = j5 === null ? j5Prompt(message) : null;
  return {
    ...presentation,
    ...(prompt === null
      ? null
      : { attribution: "automation" as const, text: prompt.text, scheduledTaskId: undefined }),
    prompt,
    // Another person's message in a shared conversation sits on the left, named (AC16).
    sharedAuthor,
    // The platform's words are never the reader's, even in a notice nothing here can read.
    side:
      sharedAuthor !== undefined && !sharedAuthor.you
        ? "left"
        : (j5?.side ?? (message.createdBy === "system" ? "left" : "right")),
    preview: j5?.group === "participant" && j5.unwrapped ? j5.preview : null,
  };
}

/** J5's platform prompts other than an automation run, which upstream's row reads itself. */
function j5Prompt(message: J5UserMessageInput) {
  const j5 = presentJ5UserMessage(message);
  if (j5?.group !== "prompt" || j5.kind === "automation") return null;
  const kind: Exclude<J5PromptKind, "automation"> = j5.kind;
  return { kind, label: j5.label, preview: j5.preview, text: j5.text };
}

export type J5FeedMessagePresentation = ReturnType<typeof resolveJ5FeedMessage>;

/**
 * A queued message J5 took out of an envelope: who sent it and the letter's first line, for the
 * queue sheet's row. Null for anything upstream's row already reads as written.
 */
export function presentJ5QueuedMessage(message: J5UserMessageInput, timeline: J5Timeline) {
  const { j5, text } = resolveJ5FeedMessage(message, timeline);
  return j5?.unwrapped ? { j5, preview: firstLine(text) } : null;
}

/**
 * The fold header for a message J5 read. Folded, it has no label, since the identity line above
 * names the sender. Open, it names the sender (or leaves upstream's sender-thread title) and drops
 * the summary when the body already opens with it; a Crew seat's brief keeps it, because its body
 * opens with the Crew's facts.
 */
export function j5FoldHeader(
  presentation: J5FeedMessagePresentation,
  timeline: J5Timeline,
  expanded: boolean,
  summary: string,
): { readonly label?: string; readonly summary: string } {
  const j5 = presentation.j5;
  if (j5 === null) return { summary };
  if (!expanded) return { label: "", summary };
  const name =
    j5.group === "participant" && j5.senderId !== null ? timeline.labels.get(j5.senderId) : null;
  const openSummary = summary === firstLine(presentation.text) ? "" : summary;
  return name ? { label: name, summary: openSummary } : { summary: openSummary };
}

/**
 * J5's platform notices, drawn in place of upstream's row: what a Crew member was told, a Crew
 * notice, and any notice the classifier has a summary for, with participants named. Null for
 * every other message, a notice nothing here can read included, which upstream's row shows.
 */
export function presentJ5TimelineNotice(
  message: J5UserMessageInput,
  labels: ReadonlyMap<string, string>,
):
  | { readonly kind: "context"; readonly title: string; readonly text: string }
  | { readonly kind: "crew"; readonly notice: CrewNoticePresentation }
  | {
      readonly kind: "line";
      readonly noticeKind: J5NoticeKind;
      readonly summary: string;
      readonly detail: string | null;
    }
  | null {
  if (message.role !== "user" || message.createdBy !== "system") return null;
  const context = presentCrewContext(message);
  if (context !== null) return { kind: "context", title: context.title, text: context.text };
  const crew = presentCrewNotice(message);
  if (crew !== null) return { kind: "crew", notice: crew };
  const notice = presentJ5UserMessage(message);
  if (notice?.group !== "notice" || notice.summary === null) return null;
  const named = (text: string) => nameJ5NoticeParticipants(text, notice.participantIds, labels);
  return {
    kind: "line",
    noticeKind: notice.kind,
    summary: named(notice.summary),
    detail: notice.detail === null ? null : named(notice.detail),
  };
}

import {
  j5MessageAuthorName,
  j5SenderThreadRef,
} from "@t3tools/client-runtime/j5/participant-identity";
import {
  crewApprovalSummary,
  crewDeclinedSummary,
  crewNoticeLines,
  type CrewNoticePresentation,
} from "@t3tools/client-runtime/j5/crew-notices";
import type {
  J5NoticeKind,
  J5PromptKind,
  J5UserMessageInput,
  J5UserMessagePresentation,
} from "@t3tools/client-runtime/j5/user-message";
import { isSharedNote } from "@t3tools/client-runtime/j5/shared-conversation";
import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useOpenLinkedThread } from "../../features/threads/useOpenLinkedThread";
import { cn } from "../../lib/cn";
import { useQuietThreadShell } from "../../state/entities";
import { PersonAvatar } from "../sharing/PersonAvatar";
import { SharedConversationNote } from "../sharing/SharedConversationNote";
import {
  presentJ5TimelineNotice,
  type J5FeedMessagePresentation,
  type J5Timeline,
} from "./timelinePresentation";

export {
  j5FoldHeader,
  resolveJ5FeedMessage,
  type J5FeedMessagePresentation,
  type J5Timeline,
} from "./timelinePresentation";

/**
 * J5's platform notices in place of upstream's row, each one grey line on the left that opens
 * to its detail (web's `J5NoticeLine`): a shared conversation's note, what a Crew member was told,
 * a Crew notice's lines, and every notice the classifier has a summary for.
 */
export function renderJ5TimelineNotice(input: {
  readonly message: J5UserMessageInput;
  readonly timestampLabel: string;
  readonly timeline: J5Timeline;
}) {
  if (isSharedNote(input.message)) {
    return <SharedConversationNote message={input.message} timestampLabel={input.timestampLabel} />;
  }
  const notice = presentJ5TimelineNotice(input.message, input.timeline.labels);
  if (notice === null) return null;
  if (notice.kind === "crew") {
    return (
      <CrewNotice
        notice={notice.notice}
        timestampLabel={input.timestampLabel}
        environmentId={String(input.timeline.environmentId)}
      />
    );
  }
  return (
    <View className="mb-5 items-start px-1">
      {notice.kind === "context" ? (
        // What the model read, long and not written for the person, so it opens on request.
        <J5NoticeLine
          icon="person.2"
          summary={`${notice.title} from J5`}
          timestampLabel={input.timestampLabel}
        >
          <Text selectable className="font-mono text-xs leading-relaxed text-foreground-muted">
            {notice.text}
          </Text>
        </J5NoticeLine>
      ) : (
        <J5NoticeLine
          icon={NOTICE_ICONS[notice.noticeKind] ?? "bell.badge"}
          summary={notice.summary}
          timestampLabel={input.timestampLabel}
        >
          {notice.detail === null ? null : <J5NoticeDetailText text={notice.detail} />}
        </J5NoticeLine>
      )}
    </View>
  );
}

const NOTICE_ICONS: Partial<Record<J5NoticeKind, AppSymbolName>> = {
  silence: "bubble.left",
  "not-delivered": "exclamationmark.circle",
  "exchange-dropped": "slash.circle",
  "exchange-withdrawn": "arrow.uturn.backward",
};

/** The icon for each of J5's prompts in upstream's Automation row. */
export const J5_PROMPT_ICONS: Record<Exclude<J5PromptKind, "automation">, AppSymbolName> = {
  "playbook-step": "list.number",
  "native-question": "questionmark.bubble",
};

const TONE_TINT = {
  bad: "accent-danger-foreground",
  warn: "accent-warning-foreground",
  none: "accent-foreground-muted",
} as const;

/** One grey line with an icon, a summary and the time; with a detail, it opens beneath a rule. */
function J5NoticeLine(props: {
  readonly icon: AppSymbolName;
  readonly tone?: keyof typeof TONE_TINT;
  readonly summary: string;
  readonly timestampLabel: string;
  readonly children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const hasDetail = props.children !== undefined && props.children !== null;
  const line = (
    <>
      <SymbolView
        name={props.icon}
        size={13}
        tintColorClassName={TONE_TINT[props.tone ?? "none"]}
        type="monochrome"
      />
      <Text
        numberOfLines={open ? undefined : 1}
        className="min-w-0 shrink text-xs text-foreground-muted"
      >
        {props.summary}
      </Text>
      {props.timestampLabel ? (
        <Text className="shrink-0 text-xs tabular-nums text-foreground-muted opacity-70">
          {props.timestampLabel}
        </Text>
      ) : null}
    </>
  );
  const lineClass = "max-w-full flex-row items-center gap-1.5 py-0.5";
  return (
    <View className="max-w-[85%] items-start gap-1">
      {hasDetail ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          hitSlop={6}
          className={lineClass}
          onPress={() => setOpen((value) => !value)}
        >
          {line}
          <SymbolView
            name={open ? "chevron.up" : "chevron.down"}
            size={11}
            tintColorClassName="accent-chevron"
            type="monochrome"
          />
        </Pressable>
      ) : (
        <View className={lineClass}>{line}</View>
      )}
      {hasDetail && open ? (
        <View className="ml-1.5 max-w-full border-l border-border pl-3">{props.children}</View>
      ) : null}
    </View>
  );
}

function J5NoticeDetailText(props: { readonly text: string }) {
  return (
    <Text selectable className="text-xs leading-relaxed text-foreground-muted">
      {props.text}
    </Text>
  );
}

function OpenSeatThread(props: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly label: string;
}) {
  const openLinkedThread = useOpenLinkedThread();
  return (
    <Pressable
      accessibilityRole="link"
      hitSlop={6}
      onPress={() =>
        openLinkedThread({ environmentId: props.environmentId, threadId: props.threadId })
      }
    >
      <Text className="font-t3-medium text-xs text-foreground-secondary">{props.label}</Text>
    </Pressable>
  );
}

/**
 * A Crew notice in the Captain's thread (web's `renderCrewNotice`): the approval or decline line,
 * then one line per seat that needs the person. A seat whose thread was never created has no link.
 */
function CrewNotice(props: {
  readonly notice: CrewNoticePresentation;
  readonly timestampLabel: string;
  readonly environmentId: string;
}) {
  const { notice, timestampLabel, environmentId } = props;
  if (notice.kind === "gate" && notice.decision === "declined") {
    const requested = notice.requestedSeats
      .map((seat) => `${seat.seat} (${seat.agentId})`)
      .join(", ");
    return (
      <View className="mb-5 items-start px-1">
        <J5NoticeLine
          icon="person.2"
          summary={crewDeclinedSummary(notice)}
          timestampLabel={timestampLabel}
        >
          <J5NoticeDetailText
            text={`${requested.length === 0 ? "" : `Requested: ${requested}\n\n`}The Captain can revise the request and propose again.`}
          />
        </J5NoticeLine>
      </View>
    );
  }
  const summary = crewApprovalSummary(notice);
  return (
    <View className="mb-5 items-start gap-1 px-1">
      {summary === null || notice.kind !== "gate" ? null : (
        <J5NoticeLine icon="person.2" summary={summary} timestampLabel={timestampLabel}>
          {notice.changes === null ? null : (
            <J5NoticeDetailText text={`Changed by the person: ${notice.changes}.`} />
          )}
          <View className="mt-1 flex-row flex-wrap items-center gap-3">
            {notice.roster.map((seat) => (
              <OpenSeatThread
                key={seat.threadId}
                environmentId={environmentId}
                threadId={seat.threadId}
                label={seat.seat}
              />
            ))}
          </View>
        </J5NoticeLine>
      )}
      {crewNoticeLines(notice).map((line, index) => (
        <J5NoticeLine
          // oxlint-disable-next-line react/no-array-index-key -- a folded notice can repeat a seat with the same reason, so no field is unique.
          key={`${line.threadId ?? line.seat}:${index}`}
          icon={line.tone === "bad" ? "exclamationmark.circle" : "exclamationmark.triangle"}
          tone={line.tone}
          summary={[line.crewName, line.seat, line.reason].filter(Boolean).join(" ")}
          timestampLabel={timestampLabel}
        >
          {line.detail === null && line.threadId === null ? null : (
            <>
              {line.detail === null ? null : <J5NoticeDetailText text={line.detail} />}
              {line.threadId === null ? null : (
                <View className="mt-1 flex-row">
                  <OpenSeatThread
                    environmentId={environmentId}
                    threadId={line.threadId}
                    label="Open seat thread"
                  />
                </View>
              )}
            </>
          )}
        </J5NoticeLine>
      ))}
    </View>
  );
}

export function Tag(props: { readonly label: string; readonly tone?: "warning" | "success" }) {
  return (
    <View
      className={cn(
        "shrink-0 rounded-full border px-1.5",
        props.tone === "warning"
          ? "border-warning-border bg-warning"
          : props.tone === "success"
            ? "border-transparent bg-adaptive-emerald-500-a12-a16"
            : "border-border",
      )}
    >
      <Text
        className={cn(
          "font-t3-medium text-2xs",
          props.tone === "warning"
            ? "text-warning-foreground"
            : props.tone === "success"
              ? "text-adaptive-emerald-700-300"
              : "text-foreground-muted",
        )}
      >
        {props.label}
      </Text>
    </View>
  );
}

function useSenderThread(
  message: J5UserMessageInput & { readonly senderThreadId?: string | undefined },
  presentation: J5FeedMessagePresentation,
  timeline: J5Timeline,
) {
  const ref = j5SenderThreadRef({
    environmentId: timeline.environmentId,
    presentation: presentation.j5,
    messageSenderThreadId: message.senderThreadId,
    participantThreads: timeline.threads,
  });
  // A peer's thread opens only from a client connected to that peer, and only if the person can
  // see it there; the client's own thread list answers both.
  const shell = useQuietThreadShell(presentation.j5?.group === "participant" ? ref : null);
  return { ref: shell === null ? null : ref, title: shell?.title };
}

/**
 * The line above a message from anyone but the reader, or above the reader's Inbox reply: who is
 * speaking, with at most one tag or badge. Nothing for a message J5 did not read.
 */
export function J5MessageAuthorLine(props: {
  readonly message: J5UserMessageInput & { readonly senderThreadId?: string | undefined };
  readonly presentation: J5FeedMessagePresentation;
  readonly timeline: J5Timeline;
}) {
  const j5 = props.presentation.j5;
  if (j5 === null) return null;
  if (j5.group === "person") {
    if (j5.viaInbox) {
      return <Text className="mb-1 pr-1 text-2xs text-foreground-muted">You · via Inbox</Text>;
    }
    const author = props.presentation.sharedAuthor;
    if (author === undefined) return null;
    // The reader's own message names only who edited it while it was queued.
    if (author.you) {
      return author.editedBy === null ? null : (
        <Text className="mb-1 pr-1 text-2xs text-foreground-muted">
          Edited by {author.editedBy}
        </Text>
      );
    }
    return (
      <PersonLine name={author.name}>
        <Text className="font-t3-medium text-xs text-foreground">
          {author.name ?? "Someone without a name"}
        </Text>
        {author.editedBy === null ? null : ` · edited by ${author.editedBy}`}
      </PersonLine>
    );
  }
  if (j5.group === "other-person") {
    const name = j5MessageAuthorName({
      presentation: j5,
      participantLabels: props.timeline.labels,
      senderThreadTitle: undefined,
    });
    return (
      <PersonLine name={j5.senderName ?? props.timeline.labels.get(j5.senderId) ?? null}>
        <Text className="font-t3-medium text-xs text-foreground">{name}</Text> · via Inbox
      </PersonLine>
    );
  }
  if (j5.group !== "participant") return null;
  return <ParticipantAuthorLine {...props} j5={j5} />;
}

/** Another person's line above their message: their avatar, then their name and what follows. */
function PersonLine(props: { readonly name: string | null; readonly children: ReactNode }) {
  return (
    <View className="mb-1 max-w-[85%] flex-row items-center gap-1.5 pl-1">
      <PersonAvatar name={props.name} />
      <Text className="shrink text-xs text-foreground-muted" numberOfLines={1}>
        {props.children}
      </Text>
    </View>
  );
}

/** The identity line above a participant's letter: the sender's name and one tag or badge. */
function ParticipantAuthorLine(props: {
  readonly message: J5UserMessageInput & { readonly senderThreadId?: string | undefined };
  readonly presentation: J5FeedMessagePresentation;
  readonly timeline: J5Timeline;
  readonly j5: Extract<J5UserMessagePresentation, { group: "participant" }>;
}) {
  const { j5 } = props;
  const openLinkedThread = useOpenLinkedThread();
  const sender = useSenderThread(props.message, props.presentation, props.timeline);
  const name = j5MessageAuthorName({
    presentation: j5,
    participantLabels: props.timeline.labels,
    senderThreadTitle: sender.title,
  });
  const { ref } = sender;
  return (
    <View className="mb-1 max-w-[85%] flex-row items-center gap-1.5 pl-1">
      {/* The sender's name opens its thread where the reader can see it, as web's link does. */}
      {ref === null ? (
        <Text className="shrink font-t3-medium text-xs text-foreground" numberOfLines={1}>
          {name}
        </Text>
      ) : (
        <Pressable
          accessibilityRole="link"
          accessibilityHint="Opens the sender's thread"
          hitSlop={6}
          className="shrink"
          onPress={() =>
            openLinkedThread({
              environmentId: String(ref.environmentId),
              threadId: String(ref.threadId),
            })
          }
        >
          <Text className="font-t3-medium text-xs text-foreground" numberOfLines={1}>
            {name}
          </Text>
        </Pressable>
      )}
      {j5.tag === "brief" ? (
        <Text className="shrink-0 text-xs text-foreground-muted">· brief</Text>
      ) : null}
      {j5.tag === "automation" ? <Tag label="Automation" /> : null}
      {j5.tag === "outside-agent" ? <Tag label="Outside agent" /> : null}
      {j5.badge === "expects-reply" ? <Tag label="Expects reply" tone="warning" /> : null}
      {j5.badge === "replied" ? <Tag label="Replied" tone="success" /> : null}
    </View>
  );
}

/**
 * The opened row's "Open thread" for a message J5 read: the sender's resolved thread, which
 * upstream's footer cannot reach for a spawn brief or a peer's message (no `senderThreadId`).
 */
export function J5OpenSenderThread(props: {
  readonly message: J5UserMessageInput & { readonly senderThreadId?: string | undefined };
  readonly presentation: J5FeedMessagePresentation;
  readonly timeline: J5Timeline;
}) {
  const openLinkedThread = useOpenLinkedThread();
  const { ref } = useSenderThread(props.message, props.presentation, props.timeline);
  if (ref === null) return null;
  return (
    <Pressable
      accessibilityRole="link"
      hitSlop={6}
      onPress={() =>
        openLinkedThread({
          environmentId: String(ref.environmentId),
          threadId: String(ref.threadId),
        })
      }
    >
      <Text className="font-t3-medium text-xs text-foreground-secondary">Open thread</Text>
    </Pressable>
  );
}

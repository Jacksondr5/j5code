import { useAtomValue } from "@effect/atom-react";
import {
  j5MessageAuthorName,
  j5SenderThreadRef,
} from "@t3tools/client-runtime/j5/participant-identity";
import {
  participantIdsForJ5UserMessage,
  type J5UserMessageInput,
} from "@t3tools/client-runtime/j5/user-message";
import type { EnvironmentId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useOpenLinkedThread } from "../../features/threads/useOpenLinkedThread";
import { cn } from "../../lib/cn";
import { useQuietThreadShell } from "../../state/entities";
import { j5Sharing } from "../sharing/guestAccess";
import { useParticipantIdentities } from "./participantIdentities";
import {
  presentJ5TimelineNotice,
  type J5FeedMessagePresentation,
  type J5Timeline,
} from "./timelinePresentation";

export { resolveJ5FeedMessage, type J5Timeline } from "./timelinePresentation";

export function useJ5Timeline(
  environmentId: EnvironmentId,
  messages: ReadonlyArray<J5UserMessageInput>,
): J5Timeline {
  const access = useAtomValue(j5Sharing.connectionAccess(environmentId));
  const identities = useParticipantIdentities(
    environmentId,
    messages.flatMap((message) => participantIdsForJ5UserMessage(message)),
  );
  return {
    ...identities,
    environmentId,
    viewerParticipantId: access?.kind === "person" ? access.personId : null,
  };
}

/** Silence lines and raw cards in place of upstream's row (`presentJ5TimelineNotice`). */
export function renderJ5TimelineNotice(input: {
  readonly message: J5UserMessageInput;
  readonly timestampLabel: string;
}) {
  const notice = presentJ5TimelineNotice(input.message);
  if (notice === null) return null;
  if (notice.kind === "silence") {
    return (
      <View className="mb-5 items-start px-1">
        <Text className="text-xs text-foreground-muted">
          ⚠ {notice.summary}
          {input.timestampLabel ? ` · ${input.timestampLabel}` : null}
        </Text>
      </View>
    );
  }
  return (
    <View className="mb-5 gap-1.5 rounded-xl border border-border bg-card p-3">
      <Text className="font-t3-medium text-xs text-foreground-muted">{notice.label}</Text>
      <Text selectable className="font-mono text-xs leading-relaxed text-foreground">
        {input.message.text}
      </Text>
    </View>
  );
}

function Tag(props: { readonly label: string; readonly tone?: "warning" | "success" }) {
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
  const sender = useSenderThread(props.message, props.presentation, props.timeline);
  if (j5 === null) return null;
  if (j5.group === "person") {
    return j5.viaInbox ? (
      <Text className="mb-1 pr-1 text-2xs text-foreground-muted">You · via Inbox</Text>
    ) : null;
  }
  const name = j5MessageAuthorName({
    presentation: j5,
    participantLabels: props.timeline.labels,
    senderThreadTitle: sender.title,
  });
  if (j5.group === "other-person") {
    return (
      <Text className="mb-1 pl-1 text-xs text-foreground-muted" numberOfLines={1}>
        <Text className="font-t3-medium text-xs text-foreground">{name}</Text> · via Inbox
      </Text>
    );
  }
  return (
    <View className="mb-1 max-w-[85%] flex-row items-center gap-1.5 pl-1">
      <Text className="shrink font-t3-medium text-xs text-foreground" numberOfLines={1}>
        {name}
      </Text>
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

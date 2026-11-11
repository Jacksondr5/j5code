import { j5MessageAuthorName } from "@t3tools/client-runtime/j5/participant-identity";
import type {
  J5UserMessageInput,
  J5UserMessagePresentation,
} from "@t3tools/client-runtime/j5/user-message";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Tag } from "./timeline";
import { presentJ5QueuedMessage } from "./timelinePresentation";
import { useJ5Timeline } from "./timelineState";

/**
 * The queue sheet's reading of a message J5 delivered (D38): the sender line names who sent it,
 * with its tag or badge, and the row shows the letter's first line rather than the envelope.
 * Both answer null for a message J5 did not unwrap, which leaves it to upstream's row.
 */
export function useJ5QueuedDeliveries(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  queued: ReadonlyArray<{ readonly message?: J5UserMessageInput | undefined }>,
) {
  const timeline = useJ5Timeline(
    environmentId,
    threadId,
    queued.flatMap(({ message }) => (message ? [message] : [])),
  );
  return {
    preview: (message: J5UserMessageInput | undefined): string | null =>
      (message && presentJ5QueuedMessage(message, timeline)?.preview) || null,
    sender: (message: J5UserMessageInput): ReactNode => {
      const queued = presentJ5QueuedMessage(message, timeline);
      return queued ? <J5QueuedSender j5={queued.j5} labels={timeline.labels} /> : null;
    },
  };
}

function J5QueuedSender(props: {
  readonly j5: J5UserMessagePresentation;
  readonly labels: ReadonlyMap<string, string>;
}) {
  const { j5 } = props;
  if (j5.group === "person") return j5.viaInbox ? <SenderLine name="You · via Inbox" /> : null;
  const name = j5MessageAuthorName({
    presentation: j5,
    participantLabels: props.labels,
    senderThreadTitle: undefined,
  });
  if (j5.group !== "participant") {
    return <SenderLine name={j5.group === "other-person" ? `${name} · via Inbox` : name} />;
  }
  return (
    <SenderLine name={name}>
      {j5.tag === "automation" ? <Tag label="Automation" /> : null}
      {j5.tag === "outside-agent" ? <Tag label="Outside agent" /> : null}
      {j5.badge === "expects-reply" ? <Tag label="Expects reply" tone="warning" /> : null}
      {j5.badge === "replied" ? <Tag label="Replied" tone="success" /> : null}
    </SenderLine>
  );
}

function SenderLine(props: { readonly name: string | null; readonly children?: ReactNode }) {
  return (
    <View className="flex-row items-center gap-1">
      <Text
        numberOfLines={1}
        className="min-w-0 shrink font-t3-medium text-2xs text-foreground-muted"
      >
        {props.name}
      </Text>
      {props.children}
    </View>
  );
}

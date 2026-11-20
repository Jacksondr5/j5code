import type { PresentedHumanInboxItem } from "@t3tools/client-runtime/j5/inbox";
import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { J5CompactButton } from "../components/J5CompactButton";
import { useOwnerAskAction } from "./OwnerAskAction";

/**
 * An ask's actions below its answer box, in the Inbox and the Captain's dock: `leading` on the
 * left, the Owner action and Answer on the right. Whichever is sending keeps its look with a
 * spinner, and the other ignores taps until it finishes. Key it by the ask, so an Owner action's
 * retry id never carries to the next one.
 */
export function AnswerActionRow(props: {
  readonly item: PresentedHumanInboxItem;
  readonly leading?: ReactNode;
  /** Who answered, for an ask that closed while the person had typed into it. */
  readonly closedText: string | null;
  /** This ask's answer is sending. */
  readonly sending: boolean;
  /** An answer is sending elsewhere on the same screen. */
  readonly busy: boolean;
  readonly canAnswer: boolean;
  readonly hasWords: boolean;
  readonly onAnswer: () => void;
}) {
  const { item } = props;
  const owner = useOwnerAskAction(item.environmentId, item);
  const ownerPending = owner?.pending === true;
  return (
    <View className="flex-row flex-wrap items-center justify-between gap-2">
      {props.leading ?? <View />}
      {props.closedText !== null ? (
        <Text className="text-sm text-foreground-muted">{props.closedText}</Text>
      ) : (
        <View className="flex-row items-center gap-2">
          {owner === null ? null : (
            <J5CompactButton
              label={owner.label}
              loading={owner.pending}
              inactive={props.sending || props.busy}
              disabled={!item.sourceReady}
              // What it does, which web shows on hover.
              accessibilityHint={owner.detail}
              onPress={() => void owner.run()}
            />
          )}
          <J5CompactButton
            label="Answer"
            tone="primary"
            loading={props.sending}
            inactive={props.busy || ownerPending}
            disabled={!props.canAnswer || !props.hasWords}
            accessibilityHint={
              props.canAnswer
                ? undefined
                : "This server is unavailable or this connection is read-only."
            }
            onPress={props.onAnswer}
          />
        </View>
      )}
    </View>
  );
}

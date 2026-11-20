import type { PresentedHumanInboxItem } from "@t3tools/client-runtime/j5/inbox";
import type { ReactNode } from "react";
import { type StyleProp, type TextStyle, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { J5CompactButton } from "../components/J5CompactButton";
import { AnswerAttachRow, AnswerPasteTarget } from "./AnswerAttachments";
import { useOwnerAskAction } from "./OwnerAskAction";

/**
 * An ask's answer box and actions, shared by the Inbox and the Captain's dock. While the answer or
 * the Owner action sends, that button shows a spinner and the rest ignore taps, all keeping their
 * look. Key it by the ask, so an Owner action's retry id never carries to the next one.
 */
export function AnswerArea(props: {
  readonly item: PresentedHumanInboxItem;
  readonly text: string;
  readonly onChangeText: (text: string) => void;
  readonly inputStyle: StyleProp<TextStyle>;
  readonly leading?: ReactNode;
  /** Who answered, for an ask that closed while the person had typed into it. */
  readonly closedText: string | null;
  /** This ask's answer is sending. */
  readonly sending: boolean;
  /** An answer is sending elsewhere on the same screen. */
  readonly busy: boolean;
  readonly canAnswer: boolean;
  readonly error?: string | null;
  readonly onAnswer: () => void;
}) {
  const { item } = props;
  const owner = useOwnerAskAction(item.environmentId, item);
  const ownerPending = owner?.pending === true;
  const held = props.busy || props.sending || ownerPending;
  return (
    <>
      <AnswerAttachRow
        target={item}
        disabled={!props.canAnswer || props.closedText !== null}
        held={held}
      />
      <AnswerPasteTarget target={item} disabled={held}>
        <TextInput
          accessibilityLabel={`Answer ${item.intent}`}
          multiline
          placeholder="Type the answer exactly as it should be delivered"
          value={props.text}
          onChangeText={props.onChangeText}
          style={props.inputStyle}
        />
      </AnswerPasteTarget>
      {props.error === undefined || props.error === null ? null : (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {props.error}
        </Text>
      )}
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <View pointerEvents={held ? "none" : "auto"}>{props.leading}</View>
        {props.closedText !== null ? (
          <Text className="text-sm text-foreground-muted">{props.closedText}</Text>
        ) : (
          <View className="flex-row items-center gap-2">
            {owner === null ? null : (
              <J5CompactButton
                label={owner.label}
                loading={owner.pending}
                inactive={props.busy || props.sending}
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
              disabled={!props.canAnswer || props.text.length === 0}
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
    </>
  );
}

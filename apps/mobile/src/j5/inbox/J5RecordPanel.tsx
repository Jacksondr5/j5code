import { splitRecordText } from "@t3tools/client-runtime/j5/inbox";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

/**
 * J5's own record, apart from the agent's words, as web's panel shows it: plain text, so they
 * can't alter it, and an indented block it quotes, such as a persona draft's definition, keeps its
 * layout and scrolls sideways.
 */
export function J5RecordPanel(props: { readonly text: string }) {
  return (
    <View className="gap-1 rounded-lg bg-subtle px-3 py-2">
      <Text className="text-xs font-t3-medium text-foreground-muted">Recorded by J5</Text>
      {splitRecordText(props.text).map((part, index) =>
        part.kind === "block" ? (
          // oxlint-disable-next-line react/no-array-index-key -- the parts are the record's fixed order.
          <ScrollView key={index} horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
            <Text selectable className="font-mono text-xs">
              {part.text}
            </Text>
          </ScrollView>
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- the parts are the record's fixed order.
          <Text key={index} className="text-sm">
            {part.text}
          </Text>
        ),
      )}
    </View>
  );
}

import { splitRecordText } from "@t3tools/client-runtime/j5/inbox";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

/**
 * J5's own record, apart from the agent's words, as web's panel shows it: plain text, so they
 * can't alter it, and an indented block it quotes, such as a persona draft's definition, keeps
 * each line's indent, and a long line wraps under it.
 */
export function J5RecordPanel(props: { readonly text: string }) {
  return (
    <View className="gap-1 rounded-lg bg-subtle px-3 py-2">
      <Text className="text-xs font-t3-medium text-foreground-muted">Recorded by J5</Text>
      {splitRecordText(props.text).map((part, index) =>
        part.kind === "block" ? (
          // oxlint-disable-next-line react/no-array-index-key -- the parts are the record's fixed order.
          <View key={index}>
            {part.lines.map((line, lineIndex) => (
              // oxlint-disable-next-line react/no-array-index-key -- a line's place is its identity.
              <View key={lineIndex} className="flex-row">
                <Text className="font-mono text-xs">{line.indent}</Text>
                <Text selectable className="flex-1 font-mono text-xs">
                  {line.text === "" ? " " : line.text}
                </Text>
              </View>
            ))}
          </View>
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

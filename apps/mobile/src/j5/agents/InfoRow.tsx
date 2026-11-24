import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";

/** A muted line inside a settings card: loading, empty, or an error in danger tone. */
export function InfoRow(props: {
  readonly text: string;
  readonly tone?: "danger";
  readonly borderTop?: boolean;
}) {
  return (
    <View className={cn("px-4 py-3", props.borderTop && "border-t border-border-subtle")}>
      <Text
        className={cn(
          "text-base",
          props.tone === "danger" ? "text-danger-foreground" : "text-foreground-muted",
        )}
      >
        {props.text}
      </Text>
    </View>
  );
}

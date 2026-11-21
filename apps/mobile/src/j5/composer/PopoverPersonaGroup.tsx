import type { ComposerTriggerKind } from "@t3tools/shared/composerTrigger";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

/**
 * How many personas lead a bare `@` list, ahead of upstream's thread and file rows (AC-3). They
 * get their own "Personas" heading, and upstream's "Files" heading moves to where they end.
 */
export function leadingPersonaCount(
  triggerKind: ComposerTriggerKind | null,
  items: ReadonlyArray<{ readonly type: string }>,
): number {
  if (triggerKind !== "path") return 0;
  const end = items.findIndex((item) => item.type !== "agent");
  return end === -1 ? items.length : end;
}

/** Upstream's popover group heading, repeated inside the list where the personas end. */
export function PopoverGroupHeading(props: { readonly label: string }) {
  return (
    <View className="px-3.5 pt-2.5 pb-1">
      <Text className="text-3xs font-t3-bold tracking-[0.8px] uppercase text-foreground-muted">
        {props.label}
      </Text>
    </View>
  );
}

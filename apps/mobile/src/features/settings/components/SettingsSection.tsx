import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/AppText";

export function SettingsSection(props: {
  readonly title?: string;
  readonly children: ReactNode;
  readonly headerAction?: ReactNode;
  /** Force the grouped card background; Android otherwise lists options flat. */
  readonly card?: boolean;
}) {
  return (
    <View className="gap-2">
      {props.headerAction ? (
        <View className="flex-row flex-wrap items-center justify-between gap-3 px-2">
          {props.title ? (
            <Text className="text-sm font-t3-medium text-foreground-muted">{props.title}</Text>
          ) : null}
          {props.headerAction}
        </View>
      ) : props.title ? (
        <Text className="px-2 text-sm font-t3-medium text-foreground-muted">{props.title}</Text>
      ) : null}
      <View
        className={
          props.card
            ? "overflow-hidden rounded-[24px] border-continuous bg-card"
            : "overflow-hidden rounded-[24px] border-continuous bg-card android:bg-transparent"
        }
      >
        {props.children}
      </View>
    </View>
  );
}

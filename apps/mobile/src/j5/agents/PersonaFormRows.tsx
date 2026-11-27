import type { MenuAction } from "@react-native-menu/menu";
import { Pressable, TextInput, type TextInputProps, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";

/** A labelled input inside a settings card, as upstream's Edit scheduled task draws its fields. */
export function FormTextRow(
  props: Pick<
    TextInputProps,
    "value" | "onChangeText" | "placeholder" | "autoCapitalize" | "autoCorrect" | "multiline"
  > & {
    readonly label: string;
    readonly disabled?: boolean;
    readonly borderTop?: boolean;
    readonly tall?: boolean;
  },
) {
  const { label, disabled, borderTop, tall, ...input } = props;
  return (
    <View className={cn("gap-2 px-4 py-3", borderTop && "border-t border-border-subtle")}>
      <Text className="text-sm text-foreground-muted">{label}</Text>
      <TextInput
        {...input}
        accessibilityLabel={label}
        readOnly={disabled}
        textAlignVertical={input.multiline ? "top" : "center"}
        placeholderTextColorClassName="accent-foreground-muted"
        className={cn(
          "min-h-8 font-sans text-base text-foreground",
          input.multiline && (tall ? "min-h-40" : "min-h-16"),
        )}
      />
    </View>
  );
}

/** A setting chosen from a Menu, with its value and a chevron, as upstream's SelectRow. */
export function FormSelectRow(props: {
  readonly label: string;
  readonly value: string;
  readonly actions: MenuAction[];
  readonly onSelect: (id: string) => void;
  readonly disabled?: boolean;
  readonly borderTop?: boolean;
}) {
  return (
    <View pointerEvents={props.disabled ? "none" : "auto"}>
      <Menu
        actions={props.actions}
        onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${props.label}, ${props.value}`}
          accessibilityState={{ disabled: Boolean(props.disabled) }}
          disabled={props.disabled}
          className={cn(
            "min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70",
            props.borderTop && "border-t border-border-subtle",
            props.disabled && "opacity-45",
          )}
        >
          <Text textRole="body" className="text-foreground">
            {props.label}
          </Text>
          <Text
            textRole="footnote"
            className="min-w-0 flex-1 text-right text-foreground-muted"
            numberOfLines={1}
          >
            {props.value}
          </Text>
          <SymbolView
            name="chevron.down"
            size={14}
            tintColorClassName="accent-chevron"
            type="monochrome"
          />
        </Pressable>
      </Menu>
    </View>
  );
}

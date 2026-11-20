import { Pressable } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";

const TONES = {
  primary: [
    "border-transparent bg-primary",
    "text-primary-foreground",
    "accent-primary-foreground",
  ],
  secondary: [
    "border-secondary-border bg-secondary",
    "text-secondary-foreground",
    "accent-secondary-foreground",
  ],
  danger: ["border-transparent bg-danger", "text-danger-foreground", "accent-danger-foreground"],
} as const;

/**
 * J5's small one-row action for its own cards, where upstream's Button would wrap the row (its
 * Android button is a 48 dp Compose control). While sending it keeps its tone, label and height and
 * adds a spinner; `inactive` ignores taps without changing its look, for the card's other actions
 * while one sends.
 */
export function J5CompactButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly tone?: keyof typeof TONES;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly inactive?: boolean;
  readonly accessibilityHint?: string;
}) {
  const [container, label, spinner] = TONES[props.tone ?? "secondary"];
  const disabled = props.disabled === true;
  const ignoresTaps = disabled || props.loading === true || props.inactive === true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled: ignoresTaps, busy: props.loading === true }}
      disabled={ignoresTaps}
      onPress={props.onPress}
      className={cn(
        "min-h-9 flex-row items-center justify-center gap-1.5 rounded-full border px-3.5",
        disabled ? "border-secondary-border bg-subtle-strong" : container,
        !ignoresTaps && "active:opacity-70",
      )}
    >
      {props.loading ? <AppActivityIndicator size="small" colorClassName={spinner} /> : null}
      <AppText
        numberOfLines={1}
        className={cn("text-sm font-t3-medium", disabled ? "text-foreground-muted" : label)}
      >
        {props.label}
      </AppText>
    </Pressable>
  );
}

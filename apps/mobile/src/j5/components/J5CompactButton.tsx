import { Platform, Pressable, View } from "react-native";

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
    // Derived from the text colour, so the outline shows on every theme's card.
    "border-foreground/15 bg-secondary",
    "text-secondary-foreground",
    "accent-secondary-foreground",
  ],
  danger: ["border-transparent bg-danger", "text-danger-foreground", "accent-danger-foreground"],
} as const;

// `px-3` keeps a cleanup's three actions on one row at normal text size. Sending, the spinner sits
// 4–14 dp from the outer left edge and the label moves 6 dp right, ending 5.5 dp from the right.
const SPINNER_SIZE = 10;
const SPINNER_INSET = 3;
const LABEL_SHIFT = 6;

/**
 * J5's small one-row action for its own cards, where upstream's Button would wrap the row (its
 * Android button is a 48 dp Compose control). While sending it keeps its tone, label and size and
 * shows a spinner; `inactive` ignores taps without changing its look, for the card's other actions
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
        "min-h-9 flex-row items-center justify-center rounded-full border px-3",
        container,
        // A lasting can't-act state, as upstream's attach button dims; sending never dims.
        disabled ? "opacity-50" : !ignoresTaps && "active:opacity-70",
      )}
    >
      {/* Sending never changes the button's width: the spinner is drawn over the left padding and
          the label slides into the right padding, so nothing beside it moves. */}
      {props.loading ? (
        <View
          pointerEvents="none"
          className="absolute inset-y-0 justify-center"
          style={{ left: SPINNER_INSET }}
        >
          <View
            className="items-center justify-center"
            style={{ width: SPINNER_SIZE, height: SPINNER_SIZE }}
          >
            <AppActivityIndicator
              // iOS draws its small spinner at 20 pt only, so it is scaled down to fit.
              size={Platform.OS === "android" ? SPINNER_SIZE : "small"}
              style={
                Platform.OS === "android"
                  ? undefined
                  : { transform: [{ scale: SPINNER_SIZE / 20 }] }
              }
              colorClassName={spinner}
            />
          </View>
        </View>
      ) : null}
      <AppText
        numberOfLines={1}
        className={cn("text-sm font-t3-medium", label)}
        style={props.loading ? { transform: [{ translateX: LABEL_SHIFT }] } : undefined}
      >
        {props.label}
      </AppText>
    </Pressable>
  );
}

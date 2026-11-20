import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";

// Upstream's question-card chrome, with an edge derived from the text colour so a J5 card stands
// off the sheet on every theme.
const CARD = "rounded-[20px] border border-foreground/15 bg-card-alt p-4";

/** A J5 card: upstream's question-card chrome around J5's own compact content. */
export function J5Card(props: { readonly children: ReactNode; readonly className?: string }) {
  return <View className={cn(CARD, props.className)}>{props.children}</View>;
}

/**
 * A J5 card that opens something as a whole, with upstream's row chevron. Without `onPress` it is
 * inert and has no chevron, as for a row whose server is offline.
 */
export function J5LinkCard(props: {
  readonly children: ReactNode;
  readonly accessibilityLabel: string;
  readonly onPress: (() => void) | null;
}) {
  const { onPress } = props;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ disabled: onPress === null }}
      disabled={onPress === null}
      onPress={onPress ?? undefined}
      className={cn(CARD, "flex-row items-center gap-3", onPress !== null && "active:opacity-70")}
    >
      <View className="min-w-0 flex-1 gap-1">{props.children}</View>
      {onPress === null ? null : (
        <SymbolView
          name="chevron.right"
          size={16}
          tintColorClassName="accent-chevron"
          type="monochrome"
          weight="semibold"
        />
      )}
    </Pressable>
  );
}

/** Upstream's card eyebrow: small, bold, tracked uppercase. */
export function J5CardEyebrow(props: { readonly label: string; readonly className?: string }) {
  return (
    <AppText
      className={cn(
        "font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary",
        props.className,
      )}
    >
      {props.label}
    </AppText>
  );
}

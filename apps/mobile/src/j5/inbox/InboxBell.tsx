import { useAtomValue } from "@effect/atom-react";
import { inboxBellPresentation, mergeOpenInboxCounts } from "@t3tools/client-runtime/j5/inbox";
import { useNavigation } from "@react-navigation/native";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { BellGlyph } from "./BellGlyph";
import { inboxCountSourcesAtom } from "./inboxSources";

/**
 * The Inbox bell in the thread list's header, with the open count across every connected server.
 * It counts open asks only: Crew requests and seat approvals join it with Crews on mobile.
 * `header` sits among the header's icon buttons, `sidebar` beside the split view's filter.
 */
export function InboxBell(props: { readonly variant: "header" | "sidebar" }) {
  const navigation = useNavigation();
  const sources = useAtomValue(inboxCountSourcesAtom);
  const { badge, label } = inboxBellPresentation(mergeOpenInboxCounts(sources));
  const sidebar = props.variant === "sidebar";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      onPress={() => navigation.navigate("Inbox")}
      className={cn(
        "items-center justify-center active:opacity-70",
        sidebar ? "size-11 rounded-full bg-subtle" : "size-12",
      )}
    >
      <BellGlyph
        size={sidebar ? 16 : 22}
        tintColorClassName={sidebar ? "accent-foreground" : "accent-header-foreground"}
      />
      {badge === null ? null : (
        <View
          pointerEvents="none"
          className="absolute right-1 top-1 min-w-4 items-center justify-center rounded-full bg-primary px-1"
        >
          <Text className="text-[10px] font-t3-semibold leading-4 text-primary-foreground">
            {badge}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

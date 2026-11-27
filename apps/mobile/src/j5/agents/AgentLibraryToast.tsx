import { useEffect } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Toast } from "../../components/ui/Toast";

export interface AgentLibraryNotification {
  readonly type: "success" | "error";
  readonly title: string;
  readonly description?: string;
}

export function AgentLibraryToast(props: {
  notification: AgentLibraryNotification;
  onDismiss: () => void;
}) {
  const { notification, onDismiss } = props;
  const insets = useSafeAreaInsets();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- dismisses the toast after a delay, a timer owned by its lifetime.
  useEffect(() => {
    const timer = setTimeout(onDismiss, notification.type === "error" ? 8000 : 4000);
    return () => clearTimeout(timer);
  }, [notification, onDismiss]);
  return (
    <View
      collapsable={false}
      pointerEvents="box-none"
      className="absolute inset-x-5 z-[100]"
      style={{ bottom: Math.max(insets.bottom, 16) }}
    >
      <Toast
        tone={notification.type === "error" ? "danger" : "success"}
        message={notification.title}
        {...(notification.description === undefined
          ? {}
          : { description: notification.description })}
        dismissMode="swipe"
        onDismiss={onDismiss}
      />
    </View>
  );
}

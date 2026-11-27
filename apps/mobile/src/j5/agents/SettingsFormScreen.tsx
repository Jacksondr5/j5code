import {
  usePreventRemove,
  useNavigation,
  useRoute,
  type NavigationAction,
  type RouteProp,
} from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { AgentPersonaCreateDraft } from "@t3tools/client-runtime/j5/agent-personas";
import type { AgentPersonaEditInput, EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { PlaybookSource } from "@t3tools/contracts/j5";
import { useState, type ReactNode } from "react";
import { Platform } from "react-native";
import { KeyboardAwareScrollView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SettingsScreen } from "../../features/settings/components/SettingsScreen";
import { createFormExit } from "./formExit";

export type SettingsFormRoutes = {
  SettingsPersonaNew: {
    readonly environmentId: EnvironmentId;
    /** Prefill from an existing persona (Duplicate); the ID is treated as user-chosen. */
    readonly initial?: AgentPersonaCreateDraft;
  };
  SettingsPersonaEdit: {
    readonly environmentId: EnvironmentId;
    readonly initial: Omit<AgentPersonaEditInput, "instructions">;
  };
  SettingsPersonaFolder: {
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
  };
  SettingsPlaybookFolder: {
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
  };
  SettingsPlaybookEditor: {
    readonly environmentId: EnvironmentId;
    /** The project whose .j5/playbooks folder is in view, when one is. */
    readonly projectId?: ProjectId;
    readonly mode:
      | { readonly kind: "import" }
      | {
          readonly kind: "copy";
          readonly name: string;
          readonly source: PlaybookSource;
          readonly destination: EnvironmentId;
        }
      | {
          readonly kind: "rename";
          readonly name: string;
          readonly title: string;
          readonly source: PlaybookSource;
        };
  };
};

export function useSettingsFormNavigation() {
  return useNavigation<NativeStackNavigationProp<SettingsFormRoutes>>();
}

export function useSettingsFormParams<Name extends keyof SettingsFormRoutes>() {
  return useRoute<RouteProp<SettingsFormRoutes, Name>>().params as SettingsFormRoutes[Name];
}

/** Asks before unsaved changes are lost, and returns how to leave once the work is done. */
export function useSettingsFormExit(options: {
  readonly hasChanges: boolean;
  readonly saving: boolean;
}) {
  const navigation = useNavigation();
  const [exit] = useState(createFormExit<NavigationAction>);
  const guardBack = options.hasChanges || options.saving;
  usePreventRemove(guardBack, ({ data }) => {
    const outcome = exit.onBack(data.action, options.saving);
    if (outcome === "leave") navigation.dispatch(data.action);
    if (outcome !== "ask") return;
    Dialog.alert("Discard changes?", "Your unsaved changes will be lost.", [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard changes",
        style: "destructive",
        onPress: () => navigation.dispatch(data.action),
      },
    ]);
  });
  return {
    guardBack,
    leaveAfterSave: () => {
      const action = exit.saveLanded();
      if (action !== null) navigation.dispatch(action);
      else if (navigation.isFocused()) navigation.goBack();
    },
    saveFailed: exit.saveFailed,
  };
}

/** A pushed settings page, because Android's Menu can't draw over an RN Modal or Sheet. */
export function SettingsFormScreen(props: {
  readonly title: string;
  /** Native Back pops before removal guards; a bar action lets the guard run first. */
  readonly guardBack?: boolean;
  readonly children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  return (
    <SettingsScreen title={props.title} guardBack={props.guardBack}>
      {/* iOS keeps upstream's scroll view, which registers with the native header and insets for the
          keyboard; with it up, the home indicator area is already covered, so Save gets no extra
          padding. Android has no header marker, so keyboard-controller's scroll view lets the form
          scroll clear of the keyboard, as the Inbox does. */}
      {Platform.OS === "ios" ? (
        <ScrollView
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1"
          contentContainerClassName="gap-4 px-5 pt-4"
          contentContainerStyle={{
            paddingBottom: keyboardVisible ? 0 : Math.max(insets.bottom, 18) + 18,
          }}
        >
          {props.children}
        </ScrollView>
      ) : (
        <KeyboardAwareScrollView
          bottomOffset={80}
          keyboardShouldPersistTaps="handled"
          className="flex-1"
          contentContainerClassName="gap-4 px-5 pt-4"
          // Android's content width cap, as upstream's ScreenScrollView applies it.
          contentContainerStyle={{
            width: "100%",
            maxWidth: 720,
            alignSelf: "center",
            paddingBottom: Math.max(insets.bottom, 18) + 18,
          }}
        >
          {props.children}
        </KeyboardAwareScrollView>
      )}
    </SettingsScreen>
  );
}

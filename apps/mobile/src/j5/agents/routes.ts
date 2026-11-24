import { createNativeStackScreen } from "@react-navigation/native-stack";

import { AgentCreateScreen } from "./AgentCreateScreen";
import { AgentEditorScreen } from "./AgentEditorScreen";
import { PlaybookEditorScreen } from "../playbooks/PlaybookEditorScreen";
import { AgentFolderPickerScreen, PlaybookFolderPickerScreen } from "./AgentFolderPickerScreen";

/** The persona forms, beside upstream's settings pages (FORK.md case 103). */
export const j5SettingsFormRoutes = <Options extends object>(options: Options) => ({
  SettingsPersonaNew: createNativeStackScreen({
    screen: AgentCreateScreen,
    options: { ...options, title: "Create persona" },
  }),
  SettingsPersonaEdit: createNativeStackScreen({
    screen: AgentEditorScreen,
    options: { ...options, title: "Edit persona" },
  }),
  SettingsPersonaFolder: createNativeStackScreen({
    screen: AgentFolderPickerScreen,
    options: { ...options, title: "Choose a library folder" },
  }),
  SettingsPlaybookFolder: createNativeStackScreen({
    screen: PlaybookFolderPickerScreen,
    options: { ...options, title: "Choose a library folder" },
  }),
  SettingsPlaybookEditor: createNativeStackScreen({
    screen: PlaybookEditorScreen,
    options: { ...options, title: "Playbook" },
  }),
});

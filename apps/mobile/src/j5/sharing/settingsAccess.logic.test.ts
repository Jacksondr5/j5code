import { describe, expect, it } from "vite-plus/test";

import { settingsPageShown } from "./settingsAccess.logic";

describe("which Settings pages someone who owns no connected server sees", () => {
  it("shows the pages about the device itself", () => {
    for (const page of [
      "Settings",
      "SettingsAppearance",
      "SettingsLanguage",
      "SettingsEnvironments",
      "SettingsAbout",
    ]) {
      expect(settingsPageShown(page, false, false), page).toBe(true);
    }
  });

  it("withholds a server's pages, and any Settings page not listed as the device's", () => {
    for (const page of ["SettingsProviderAccounts", "SettingsScheduledTasks", "SettingsAgents"]) {
      expect(settingsPageShown(page, false, false), page).toBe(false);
    }
    expect(settingsPageShown("SettingsSomethingNew", false, true)).toBe(false);
  });

  it("shows Voice to a Collaborator and not to a Viewer", () => {
    expect(settingsPageShown("SettingsVoice", false, true)).toBe(true);
    expect(settingsPageShown("SettingsVoice", false, false)).toBe(false);
    expect(settingsPageShown("SettingsVoiceModels", false, true)).toBe(false);
  });

  it("withholds nothing from an Owner, or while the servers are still answering", () => {
    expect(settingsPageShown("SettingsProviderAccounts", true, true)).toBe(true);
    expect(settingsPageShown("SettingsProviderAccounts", "loading", false)).toBe(true);
  });

  it("leaves screens outside Settings alone", () => {
    expect(settingsPageShown("Thread", false, false)).toBe(true);
  });
});

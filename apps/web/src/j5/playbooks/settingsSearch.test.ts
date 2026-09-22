import { expect, it } from "vite-plus/test";
import {
  filterAvailableSettingsSearchItems,
  searchSettings,
} from "../../components/settings/settingsSearch";

it("finds playbook creation from Settings and the command palette on remote-only clients", () => {
  const items = filterAvailableSettingsSearchItems({
    hasCloudPublicConfig: false,
    hasPrimaryEnvironment: false,
    hasProviderSettingsEnvironment: false,
    canManageLocalBackend: false,
    isWslSettingsRowVisible: false,
    hasThreadAutoSettlement: false,
  });
  for (const query of ["playbooks", "create playbook", "yaml"]) {
    expect(searchSettings(query, items).some((item) => item.to === "/settings/playbooks")).toBe(
      true,
    );
  }
});

import { describe, expect, it } from "vite-plus/test";

import { settingsNavGroups, settingsPageShown } from "./settingsAccess.logic";

const UPSTREAM = [
  {
    heading: "Preferences",
    headingHidden: true as const,
    paths: ["/settings/general", "/settings/appearance", "/settings/snap-shot"],
  },
  { heading: "Agents", paths: ["/settings/providers"] },
  { heading: "Connections", paths: ["/settings/connections", "/settings/people"] },
];
const LICENSES = {
  heading: "Open-source licenses",
  headingHidden: true as const,
  paths: ["/settings/open-source-licenses"],
};

const VIEWER = { ownerSomewhere: false, writesSomewhere: false };
const COLLABORATOR = { ownerSomewhere: false, writesSomewhere: true };
const OWNER = { ownerSomewhere: true, writesSomewhere: true };

describe("Settings for someone who owns no connected server", () => {
  it("lists only the pages about their own device, People, and the licenses", () => {
    expect(settingsNavGroups(UPSTREAM, VIEWER, LICENSES)).toEqual([
      {
        heading: "Preferences",
        headingHidden: true,
        paths: ["/settings/general", "/settings/appearance", "/settings/snap-shot"],
      },
      { heading: "Connections", paths: ["/settings/people"] },
      LICENSES,
    ]);
  });

  it("does not show a page upstream adds later", () => {
    expect(settingsPageShown("/settings/brand-new", COLLABORATOR)).toBe(false);
    expect(settingsPageShown("/settings/appearance", VIEWER)).toBe(true);
  });

  it("shows Voice to a Collaborator and not to a Viewer", () => {
    expect(settingsPageShown("/settings/voice", COLLABORATOR)).toBe(true);
    expect(settingsPageShown("/settings/voice", VIEWER)).toBe(false);
  });
});

describe("Settings for an Owner", () => {
  it("lists every page upstream lists, and shows every page", () => {
    expect(settingsNavGroups(UPSTREAM, OWNER, LICENSES)).toBe(UPSTREAM);
    expect(settingsPageShown("/settings/brand-new", OWNER)).toBe(true);
  });
});

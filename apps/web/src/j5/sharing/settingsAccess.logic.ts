/**
 * The Settings pages shown to someone who owns no connected server (People and access AC28,
 * AC29): the pages about their own device, and People with their own row. Everything else is an
 * Owner's, so a page upstream adds later is shown to Owners only until someone decides otherwise.
 * General holds only device settings, Language among them.
 */
const PAGES_FOR_EVERYONE: ReadonlySet<string> = new Set([
  "/settings/general",
  "/settings/appearance",
  "/settings/snap-shot",
  "/settings/open-source-licenses",
  "/settings/people",
]);

/**
 * Pages also shown to a Collaborator: Voice, where they opt their own device in and use what an
 * Owner set up. Its key and model controls need `settings:write`, which only Owners hold.
 */
const PAGES_FOR_WRITERS: ReadonlySet<string> = new Set(["/settings/voice"]);

export const LICENSES_PATH = "/settings/open-source-licenses";

export interface SettingsAccess {
  readonly ownerSomewhere: boolean;
  /** Writes to something on a connected server: a Collaborator or an Owner somewhere. */
  readonly writesSomewhere: boolean;
}

/** Whether Settings shows a page, by its path. */
export const settingsPageShown = (path: string, access: SettingsAccess) =>
  access.ownerSomewhere ||
  PAGES_FOR_EVERYONE.has(path) ||
  (access.writesSomewhere && PAGES_FOR_WRITERS.has(path));

export interface SettingsNavGroup<Path extends string> {
  readonly heading: string;
  readonly headingHidden?: true;
  readonly paths: ReadonlyArray<Path>;
}

/**
 * Settings' navigation as a person sees it. An Owner sees upstream's groups. Anyone else sees the
 * pages they are shown, in upstream's groups, and Open-source licenses, which upstream reaches
 * only from About, as a group of its own.
 */
export function settingsNavGroups<Path extends string>(
  groups: ReadonlyArray<SettingsNavGroup<Path>>,
  access: SettingsAccess,
  licenses: SettingsNavGroup<Path>,
): ReadonlyArray<SettingsNavGroup<Path>> {
  if (access.ownerSomewhere) return groups;
  return [
    ...groups
      .map((group) => ({
        ...group,
        paths: group.paths.filter((path) => settingsPageShown(path, access)),
      }))
      .filter((group) => group.paths.length > 0),
    licenses,
  ];
}

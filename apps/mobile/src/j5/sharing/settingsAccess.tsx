import { useAtomValue } from "@effect/atom-react";
import { ownerOnlySettingsNotice } from "@t3tools/client-runtime/j5/sharing";
import type { EnvironmentId } from "@t3tools/contracts";
import { type ReactNode, useMemo } from "react";

import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { environmentPresentations } from "../../state/presentation";
import { useOwnedEnvironmentIds, useOwnerSomewhere, useWritesSomewhere } from "./guestAccess";
import { settingsPageShown } from "./settingsAccess.logic";

/**
 * Settings' index as this person sees it: a row that opens a page they are not shown is left out,
 * and so is a group left empty. Rows that open nothing, such as the account row, stay.
 */
export function useShownSettingsSections<
  Section extends { readonly rows: ReadonlyArray<{ readonly target?: string }> },
>(sections: ReadonlyArray<Section>): ReadonlyArray<Section> {
  const ownerSomewhere = useOwnerSomewhere();
  if (ownerSomewhere !== false) return sections;
  return sections
    .map((section) => ({
      ...section,
      rows: section.rows.filter(
        (row) => row.target === undefined || settingsPageShown(row.target, ownerSomewhere),
      ),
    }))
    .filter((section) => section.rows.length > 0);
}

/**
 * A Settings page's content, or, for someone who owns no connected server and reaches an Owner's
 * page by a link, the command palette or its address, a notice in its place (AC29).
 */
export function useOwnerOnlySettingsPage(routeName: string, children: ReactNode): ReactNode {
  const ownerSomewhere = useOwnerSomewhere();
  if (settingsPageShown(routeName, ownerSomewhere)) return children;
  return <OwnerOnlySettingsNotice />;
}

// A long server name in running text would be broken mid-identifier on Android.
const SERVER_NAME_LIMIT = 32;
const shortenMiddle = (name: string) =>
  name.length <= SERVER_NAME_LIMIT
    ? name
    : `${name.slice(0, SERVER_NAME_LIMIT / 2)}…${name.slice(1 - SERVER_NAME_LIMIT / 2)}`;

function OwnerOnlySettingsNotice() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  // With one saved server the notice names it; with several, it can't tell which one is meant.
  const only = presentations.size === 1 ? [...presentations.values()][0] : undefined;
  const notice = ownerOnlySettingsNotice({
    serverName: only === undefined ? null : shortenMiddle(only.entry.target.label),
    writesSomewhere: useWritesSomewhere(),
  });
  return (
    <ScreenScrollView contentInsetAdjustmentBehavior="automatic">
      <EmptyState variant="plain" title={notice.title} detail={notice.body} />
    </ScreenScrollView>
  );
}

/**
 * The servers Settings manages: only those the person owns (AC27). Upstream applies a change to
 * every selected server and disables a row unless all of them allow it, so a server the person
 * does not own would grey out an Owner's Settings for the servers that are theirs.
 */
export function useOwnedSettingsTargets<Target extends { readonly environmentId: EnvironmentId }>(
  targets: ReadonlyArray<Target>,
): ReadonlyArray<Target> {
  const owned = useOwnedEnvironmentIds();
  return useMemo(
    () => targets.filter((target) => owned.has(target.environmentId)),
    [targets, owned],
  );
}

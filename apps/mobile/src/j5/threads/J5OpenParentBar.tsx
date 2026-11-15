import { useAtomValue } from "@effect/atom-react";
import { deriveJ5LineageRows, type J5LineageRow } from "@t3tools/client-runtime/j5/lineage";
import { j5LedgerSupported } from "@t3tools/client-runtime/j5/readSources";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useOpenLinkedThread } from "../../features/threads/useOpenLinkedThread";
import { useEnvironmentServerConfig, useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { j5Sharing } from "../sharing/guestAccess";
import { j5Environment } from "../state";

/** The Captain or spawner of a Crew member or Peer Agent, from its server's Fleet roster. */
function useJ5ParentRow(environmentId: EnvironmentId, threadId: ThreadId): J5LineageRow | null {
  const supported = j5LedgerSupported(useEnvironmentServerConfig(environmentId)) !== false;
  // The roster is a server-wide read, refused to a person who reaches less (web's Lineage too).
  const narrow = useAtomValue(j5Sharing.isNarrow(environmentId));
  const fleet = useEnvironmentQuery(
    supported && !narrow ? j5Environment.fleet({ environmentId, input: {} }) : null,
  );
  return (
    deriveJ5LineageRows(fleet.data?.projects ?? [], threadId).find(
      (row) => row.role === "parent" || row.role === "captain",
    ) ?? null
  );
}

/**
 * Upstream's Open parent bar, for a Crew member or Peer Agent: above its composer, since it keeps
 * one, where upstream's bar takes a provider subagent's composer's place.
 */
export function J5OpenParentBar(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const parent = useJ5ParentRow(props.environmentId, props.threadId);
  const shell = useQuietThreadShell(
    parent === null ? null : scopeThreadRef(props.environmentId, parent.threadId),
  );
  const openLinkedThread = useOpenLinkedThread();
  if (parent === null) return null;
  const role = parent.role === "captain" ? "Captain" : "Parent agent";
  // Named as web's Lineage row names it.
  const name = shell?.title ?? parent.displayName ?? role;
  const detail = parent.crew === null ? role : `${role} · ${parent.crew.crewName}`;
  return (
    <View className="px-4 pb-2">
      <View className="flex-row items-center gap-3 rounded-[20px] border border-border-subtle bg-card-alt py-2 pe-2 ps-4">
        <View
          accessible
          accessibilityLabel={`${name}, ${detail}`}
          className="min-w-0 flex-1 gap-0.5"
        >
          <Text numberOfLines={1} className="font-t3-bold text-sm text-foreground">
            {name}
          </Text>
          <Text numberOfLines={1} className="font-sans text-xs text-foreground-secondary">
            {detail}
          </Text>
        </View>
        <Button
          label="Open parent"
          tone="secondary"
          onPress={() =>
            openLinkedThread({ environmentId: props.environmentId, threadId: parent.threadId })
          }
        />
      </View>
    </View>
  );
}

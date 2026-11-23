import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveJ5LineageRows, type J5LineageRow } from "@t3tools/client-runtime/j5/lineage";
import { j5LedgerSupported } from "@t3tools/client-runtime/j5/readSources";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentServerConfig, useQuietThreadShell } from "../../state/entities";
import { accessConfirmedAtom } from "../connection/memory";
import { j5Sharing } from "../sharing/guestAccess";
import { j5Environment } from "../state";

const NO_PARENT = Atom.make<string | null>(null).pipe(
  Atom.withLabel("mobile-j5:thread-parent:none"),
);

// The parent alone, as text, so a Fleet change that leaves it as it was doesn't re-render the
// thread screen.
const parentAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
  return Atom.make((get) => {
    // The roster is a server-wide read, refused to a person who reaches less (web's Lineage too).
    // After a re-pair it waits for the server to say who the new person is.
    if (get(j5Sharing.isNarrow(environmentId)) || !get(accessConfirmedAtom(environmentId)))
      return null;
    const fleet = AsyncResult.getOrElse(
      get(j5Environment.fleet({ environmentId, input: {} })),
      () => null,
    );
    const parent = deriveJ5LineageRows(fleet?.projects ?? [], threadId).find(
      (row) => row.role === "parent" || row.role === "captain",
    );
    return parent === undefined ? null : JSON.stringify(parent);
  }).pipe(Atom.withLabel(`mobile-j5:thread-parent:${key}`));
});

/** The Captain or spawner of a Crew member or Peer Agent, from its server's Fleet roster. */
export function useJ5ParentRow(ref: ScopedThreadRef | null): J5LineageRow | null {
  const supported =
    j5LedgerSupported(useEnvironmentServerConfig(ref?.environmentId ?? null)) !== false;
  const parent = useAtomValue(
    ref !== null && supported
      ? parentAtom(JSON.stringify([ref.environmentId, ref.threadId]))
      : NO_PARENT,
  );
  return parent === null ? null : (JSON.parse(parent) as J5LineageRow);
}

/** What a member thread's Agents pill reads when it has no agents of its own (D11). */
export const parentRoleLabel = (parent: J5LineageRow) =>
  parent.role === "captain" ? "Captain" : "Parent";

/**
 * The member thread's Captain or spawner, at the top of its Agents sheet (D11), where upstream's
 * Open parent bar would sit for a provider subagent.
 */
export function J5ParentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly parent: J5LineageRow;
  readonly onOpen: (target: { environmentId: EnvironmentId; threadId: ThreadId }) => void;
}) {
  const { parent } = props;
  const shell = useQuietThreadShell(scopeThreadRef(props.environmentId, parent.threadId));
  const role = parentRoleLabel(parent);
  // Named as web's Lineage row names it. Until a name is known the line stays blank, at its height,
  // rather than showing a placeholder that the real name then replaces.
  const name = shell?.title ?? parent.displayName ?? null;
  const detail = parent.crew === null ? role : `${role} · ${parent.crew.crewName}`;
  return (
    <View>
      <View className="min-h-11 flex-row items-center border-b border-border pt-3">
        <Text className="text-xs font-t3-medium text-foreground">Parent</Text>
      </View>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={name === null ? detail : `${name}, ${detail}`}
        accessibilityHint="Opens the parent's thread"
        onPress={() =>
          props.onOpen({ environmentId: props.environmentId, threadId: parent.threadId })
        }
        className="flex-row items-center gap-2 border-b border-border py-3.5 active:opacity-70"
      >
        <View className="min-w-0 flex-1 gap-1">
          <Text numberOfLines={1} className="font-t3-medium text-sm text-foreground">
            {name ?? " "}
          </Text>
          <Text numberOfLines={1} className="text-xs text-foreground-muted">
            {detail}
          </Text>
        </View>
        <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
      </Pressable>
    </View>
  );
}

import { rosterGatesForThread } from "@t3tools/client-runtime/j5/crew-proposals";
import { j5LedgerSupported } from "@t3tools/client-runtime/j5/readSources";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { j5Environment } from "../state";

/**
 * A Captain's open Crew proposal, above its composer: one row each, the height of the playbook
 * bar. The roster is reviewed on its own screen, since it doesn't fit above a phone keyboard.
 */
export function CrewRosterStrip(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const navigation = useNavigation();
  const supported = j5LedgerSupported(useEnvironmentServerConfig(props.environmentId)) !== false;
  const query = useEnvironmentQuery(
    supported
      ? j5Environment.crewProposals({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const gates = rosterGatesForThread(query.data ?? [], props.threadId);
  if (gates.length === 0) return null;
  return (
    <View className="gap-1 px-4 pb-2">
      {gates.map((proposal) => {
        const members = proposal.requestedSeats.length;
        const count = `${members} ${members === 1 ? "member" : "members"}`;
        const title = proposal.kind === "roster" ? "Crew proposal" : "Crew member request";
        return (
          <View key={proposal.id} className="rounded-[20px] border-continuous bg-card px-3 py-1">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${title}: ${proposal.displayName}, ${count}. Review`}
              onPress={() =>
                navigation.navigate("ThreadCrewProposal", {
                  environmentId: props.environmentId,
                  threadId: props.threadId,
                  proposalId: proposal.id,
                })
              }
              className="min-h-11 flex-row items-center gap-2"
            >
              <SymbolView name="person.2" size={14} tintColorClassName="accent-icon-muted" />
              <View className="min-w-0 flex-1">
                <Text numberOfLines={1} className="text-xs text-foreground">
                  {title}
                </Text>
                <Text numberOfLines={1} className="text-xs text-foreground-muted">
                  {proposal.displayName}
                </Text>
              </View>
              <Text className="text-xs text-foreground-muted">{count}</Text>
              <Text className="text-xs font-t3-medium text-primary-text">Review</Text>
              <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-muted" />
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

import { rosterGatesForThread } from "@t3tools/client-runtime/j5/crew-proposals";
import { j5LedgerSupported } from "@t3tools/client-runtime/j5/readSources";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { J5CardEyebrow } from "../components/J5Card";
import { j5Environment } from "../state";

/**
 * A Captain's open, human-approved Crew proposals. Each is a card in the thread's carousel that
 * opens the roster review, since a roster doesn't fit above a phone keyboard.
 */
export function useRosterGates(environmentId: EnvironmentId, threadId: ThreadId) {
  const supported = j5LedgerSupported(useEnvironmentServerConfig(environmentId)) !== false;
  const query = useEnvironmentQuery(
    supported ? j5Environment.crewProposals({ environmentId, input: {} }) : null,
  );
  return rosterGatesForThread(query.data ?? [], threadId).map((proposal) => {
    const members = proposal.requestedSeats.length;
    return {
      id: proposal.id,
      title: proposal.kind === "roster" ? "Crew proposal" : "Crew member request",
      name: proposal.displayName,
      count: `${members} ${members === 1 ? "member" : "members"}`,
    };
  });
}

export type RosterGate = ReturnType<typeof useRosterGates>[number];

/** The folded proposal card: "CREW PROPOSAL · 2 members", the Crew's name below. */
export function RosterGateFace(props: { readonly gate: RosterGate }) {
  return (
    <>
      <View className="h-4 flex-row items-center gap-1.5">
        <J5CardEyebrow label={props.gate.title} />
        <Text numberOfLines={1} className="shrink text-xs text-foreground-muted">
          · {props.gate.count}
        </Text>
      </View>
      <Text numberOfLines={1} className="text-sm font-t3-medium text-foreground">
        {props.gate.name}
      </Text>
    </>
  );
}

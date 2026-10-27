import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { UsersIcon } from "lucide-react";
import { ComposerBanner } from "../../components/chat/ComposerBanner";
import { useEnvironmentQuery } from "../../state/query";
import { notifyHumanInboxChanged } from "../a2a/humanInboxRefresh";
import { crewProposalsQueryAtom } from "../state";
import { CrewProposalCard } from "./CrewProposalCard";
import { rosterGatesForThread } from "./crewProposals.logic";
import {
  refreshCrewProposals,
  resolveCrewProposal,
  useCrewProposalsRefresh,
  type CrewProposal,
  type CrewProposalSeat,
} from "./crewProposalsClient";

export function CrewRosterGate(props: {
  readonly environmentId: EnvironmentId | undefined;
  readonly threadId: ThreadId | null | undefined;
}) {
  const { environmentId, threadId } = props;
  const query = useEnvironmentQuery(
    environmentId !== undefined && threadId != null ? crewProposalsQueryAtom(environmentId) : null,
  );
  useCrewProposalsRefresh();
  const [expanded, setExpanded] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolve = useCallback(
    async (
      proposal: CrewProposal,
      decision: "approve" | "decline",
      seats: ReadonlyArray<CrewProposalSeat>,
      approvalToken?: string,
    ) => {
      if (environmentId === undefined) return;
      setBusyId(proposal.id);
      setError(null);
      try {
        if (decision === "approve" && approvalToken === undefined)
          throw new Error("Refresh the runtime preview before approving.");
        await resolveCrewProposal(
          environmentId,
          decision === "approve"
            ? { proposalId: proposal.id, decision, seats, approvalToken: approvalToken! }
            : { proposalId: proposal.id, decision },
        );
        notifyHumanInboxChanged(environmentId);
        await refreshCrewProposals(environmentId).catch(() => undefined);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not resolve the crew request.");
      } finally {
        setBusyId(null);
      }
    },
    [environmentId],
  );

  const gates = rosterGatesForThread(query.data ?? [], threadId);
  if (gates.length === 0 || environmentId === undefined) return null;
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root density="comfortable" data-testid="crew-roster-gate">
        <ComposerBanner.Row
          render={<button type="button" />}
          aria-label={expanded ? "Collapse Crew proposal" : "Expand Crew proposal"}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          onPointerDown={(event) => event.preventDefault()}
        >
          <ComposerBanner.Icon>
            <UsersIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>Crew proposal</ComposerBanner.Content>
          <ComposerBanner.Actions>
            <ComposerBanner.Count>
              {gates.length === 1 ? "Review" : `${gates.length} proposals`}
            </ComposerBanner.Count>
            <ComposerBanner.ToggleIcon expanded={expanded} />
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        <div hidden={!expanded}>
          <ComposerBanner.Scroll>
            {error ? (
              <p className="mb-2 text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <ul className="divide-y divide-border">
              {gates.map((proposal) => (
                <CrewProposalCard
                  key={proposal.id}
                  proposal={proposal}
                  environmentId={environmentId}
                  busy={busyId === proposal.id}
                  onResolve={(decision, seats, approvalToken) =>
                    void resolve(proposal, decision, seats, approvalToken)
                  }
                />
              ))}
            </ul>
          </ComposerBanner.Scroll>
        </div>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}

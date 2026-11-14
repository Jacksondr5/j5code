import { useAtomValue } from "@effect/atom-react";
import {
  crewSeatStopsForApprovals,
  describeCrewSeatWorkspace,
  describePersonaSwap,
  removedSeatSteps,
  removeSeat,
  stepTitle,
  unownedSteps,
} from "@t3tools/client-runtime/j5/crew-proposals";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  CrewProposal,
  CrewProposalSeat,
  CrewProposalSeatRuntime,
} from "@t3tools/contracts/j5";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironmentQuery } from "../../state/query";
import { useCanOperateThread } from "../sharing/guestAccess";
import { j5Environment } from "../state";
import { resolveCrewProposal } from "./crewProposalsClient";
import { useCrewProposalPreview } from "./useCrewProposalPreview";

type Params = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly proposalId: string;
}>;

const seatTitle = (seat: string) => seat[0]!.toUpperCase() + seat.slice(1);

function SeatRow(props: {
  readonly seat: CrewProposalSeat;
  readonly runtime: CrewProposalSeatRuntime | undefined;
  readonly runtimeLoading: boolean;
  readonly playbook: CrewProposal["playbook"];
  readonly removable: boolean;
  readonly onRemove: () => void;
}) {
  const { seat, runtime } = props;
  const swaps = runtime?.personaSwaps ?? seat.personaSwaps ?? [];
  return (
    <View className="flex-row items-start gap-3 border-b border-separator py-3">
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-base font-t3-medium text-foreground">{seatTitle(seat.seat)}</Text>
        {/* The settings the approval binds: the server's resolved runtime for this exact seat. */}
        <Text className="text-sm text-foreground">
          {runtime
            ? [runtime.model.replace(/^Claude\s+/u, ""), runtime.reasoning, runtime.access].join(
                " · ",
              )
            : props.runtimeLoading
              ? "Resolving runtime…"
              : "Runtime unavailable"}
        </Text>
        <Text className="text-sm text-foreground-muted">{seat.reason}</Text>
        {runtime?.workspace && runtime.workspace.type !== "shared" ? (
          <Text className="text-sm text-foreground-muted">
            {describeCrewSeatWorkspace(runtime.workspace)}
          </Text>
        ) : null}
        {crewSeatStopsForApprovals(seat, runtime) ? (
          <Text className="text-sm text-warning-foreground">Asks for approvals</Text>
        ) : null}
        {seat.steps?.length ? (
          <Text className="text-sm text-foreground-muted">
            Steps: {seat.steps.map((id) => stepTitle(props.playbook ?? null, id)).join(", ")}
          </Text>
        ) : null}
        {swaps.map((swap) => (
          <Text key={swap.stepId} className="text-sm text-warning-foreground">
            {stepTitle(props.playbook ?? null, swap.stepId)} {describePersonaSwap(swap, seat.seat)}
          </Text>
        ))}
      </View>
      <Button
        label="Remove"
        accessibilityLabel={`Remove seat ${seat.seat}`}
        tone="text"
        disabled={!props.removable}
        onPress={props.onRemove}
      />
    </View>
  );
}

function Review(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly proposal: CrewProposal;
  readonly canResolve: boolean;
  readonly onResolved: () => void;
}) {
  const { proposal, environmentId } = props;
  const insets = useSafeAreaInsets();
  const [removed, setRemoved] = useState<ReadonlyArray<string>>([]);
  const [fullBrief, setFullBrief] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seats = removed.reduce(removeSeat, proposal.requestedSeats);
  const preview = useCrewProposalPreview(environmentId, proposal.id, seats, !busy);
  const playbook = preview.data?.playbook ?? proposal.playbook ?? null;
  const titles = (ids: ReadonlyArray<string>) =>
    ids.map((id) => stepTitle(playbook, id)).join(", ");
  const unowned =
    preview.data?.unownedSteps ?? (proposal.kind === "roster" ? unownedSteps(playbook, seats) : []);
  const canApprove = props.canResolve && !busy && preview.data !== null;

  const resolve = async (decision: "approve" | "decline") => {
    const approvalToken = preview.data?.approvalToken;
    if (decision === "approve" && approvalToken === undefined) return;
    const request =
      decision === "approve"
        ? { proposalId: proposal.id, decision, seats, approvalToken: approvalToken! }
        : { proposalId: proposal.id, decision };
    setBusy(true);
    setError(null);
    try {
      await resolveCrewProposal(environmentId, request);
      props.onResolved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't answer the Crew proposal.");
      // A token is spent by the attempt; the next approval asks for a fresh preview.
      preview.refresh();
      setBusy(false);
    }
  };

  return (
    <View className="flex-1 bg-sheet">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1 bg-sheet"
        contentContainerClassName="gap-3 px-4 py-4"
      >
        <Text className="text-xl font-t3-bold text-foreground">{proposal.displayName}</Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={fullBrief ? undefined : 2}>
          {proposal.brief}
        </Text>
        <Button
          label={fullBrief ? "View less" : "View more"}
          tone="text"
          onPress={() => setFullBrief((full) => !full)}
        />
        {playbook === null ? null : (
          <View className="gap-1">
            <Text className="text-sm text-foreground-muted">
              Follows playbook: <Text className="text-foreground">{playbook.title}</Text>
            </Text>
            {playbook.issue === null ? null : (
              <Text className="text-sm text-danger-foreground">{playbook.issue}</Text>
            )}
          </View>
        )}
        <View className="border-t border-separator">
          {seats.map((seat) => (
            <SeatRow
              key={seat.seat}
              seat={seat}
              runtime={preview.runtime.find((row) => row.seat === seat.seat)}
              runtimeLoading={preview.loading}
              playbook={playbook}
              removable={props.canResolve && !busy && seats.length > 1}
              onRemove={() => setRemoved([...removed, seat.seat])}
            />
          ))}
        </View>
        {removedSeatSteps(proposal.requestedSeats, seats).map(({ seat, steps }) => (
          <Text key={seat} className="text-sm text-foreground-muted">
            Removing {seat} leaves {titles(steps)} unowned.
          </Text>
        ))}
        {playbook !== null && unowned.length > 0 ? (
          <Text className="text-sm text-foreground-muted">
            Unowned steps, done by the Captain: {titles(unowned)}
          </Text>
        ) : null}
        {removed.length > 0 ? (
          <Button
            label="Restore removed seats"
            tone="text"
            disabled={busy}
            onPress={() => setRemoved([])}
          />
        ) : null}
        {preview.error ? (
          <View className="gap-2">
            <Text className="text-sm text-danger-foreground">{preview.error}</Text>
            <Button label="Refresh runtime" disabled={busy} onPress={preview.refresh} />
          </View>
        ) : null}
        {error ? <Text className="text-sm text-danger-foreground">{error}</Text> : null}
        <Text className="text-sm text-foreground-muted">
          {props.canResolve
            ? "To change a seat, ask the Captain in chat, or edit the proposal on web or desktop."
            : "Only someone who can write to the Captain's thread can approve or decline this Crew."}
        </Text>
      </ScreenScrollView>
      <View
        className="flex-row gap-3 border-t border-separator bg-sheet px-4 pt-3"
        style={{ paddingBottom: Math.max(insets.bottom, 12) }}
      >
        <View className="flex-1">
          <Button
            label="Decline"
            fullWidth
            disabled={!props.canResolve || busy}
            onPress={() => void resolve("decline")}
          />
        </View>
        <View className="flex-1">
          <Button
            label={proposal.kind === "roster" ? "Approve Crew" : "Approve member"}
            tone="primary"
            fullWidth
            loading={busy}
            disabled={!canApprove}
            onPress={() => void resolve("approve")}
          />
        </View>
      </View>
    </View>
  );
}

/** A Captain's Crew proposal: approve, decline, or remove seats first. */
export function CrewProposalReviewScreen(props: Params) {
  const navigation = useNavigation();
  const environmentId = props.route.params.environmentId as EnvironmentId;
  const threadId = props.route.params.threadId as ThreadId;
  const query = useEnvironmentQuery(j5Environment.crewProposals({ environmentId, input: {} }));
  const permitted = useAtomValue(j5Environment.resolveCrewProposal.permissionAtom(environmentId));
  const writesToCaptain = useCanOperateThread(environmentId, threadId);
  const proposal = query.data?.find((candidate) => candidate.id === props.route.params.proposalId);
  const header = <NativeStackScreenOptions options={{ title: "Crew proposal" }} />;
  if (proposal === undefined || proposal.status !== "open") {
    return (
      <View className="flex-1 bg-sheet">
        {header}
        <ScreenScrollView
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1 bg-sheet"
          contentContainerClassName="p-4"
        >
          {query.error !== null ? (
            <View className="gap-3">
              <EmptyState title="Couldn't load the Crew proposal" detail={query.error} />
              <Button label="Retry" onPress={query.refresh} />
            </View>
          ) : query.data === null ? (
            <Text className="text-foreground-muted">Loading the proposal…</Text>
          ) : (
            <EmptyState
              title="Already answered"
              detail={
                proposal === undefined
                  ? "This Crew proposal is no longer open."
                  : `This Crew proposal was ${proposal.status}.`
              }
            />
          )}
        </ScreenScrollView>
      </View>
    );
  }
  return (
    <>
      {header}
      <Review
        environmentId={environmentId}
        threadId={threadId}
        proposal={proposal}
        canResolve={permitted && writesToCaptain}
        onResolved={() => {
          query.refresh();
          navigation.goBack();
        }}
      />
    </>
  );
}

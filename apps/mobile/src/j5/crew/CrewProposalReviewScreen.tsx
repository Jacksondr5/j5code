import { useAtomValue } from "@effect/atom-react";
import {
  crewProposalReview,
  crewSeatStopsForApprovals,
  describeCrewSeatWorkspace,
  describePersonaSwap,
  heldCrewApprovalSends,
  removedSeatSteps,
  removeSeat,
  stepTitle,
  unownedSteps,
} from "@t3tools/client-runtime/j5/crew-proposals";
import { askWaitsForServerLine } from "@t3tools/client-runtime/j5/inbox";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  CrewProposal,
  CrewProposalPreviewResponse,
  CrewProposalSeat,
  CrewProposalSeatRuntime,
} from "@t3tools/contracts/j5";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { AppBar } from "../../components/ui/AppBar";
import { useEnvironmentQuery } from "../../state/query";
import { useCanOperateThread } from "../sharing/guestAccess";
import { j5Environment } from "../state";
import { resolveCrewProposal } from "./crewProposalsClient";
import { useServerConnection } from "./serverConnection";
import { useCrewProposalPreview } from "./useCrewProposalPreview";

type Params = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly proposalId: string;
}>;

const seatTitle = (seat: string) => seat[0]!.toUpperCase() + seat.slice(1);

/** A text action in line with the copy it belongs to; unavailable reads muted, not as a pill. */
function TextAction(props: {
  readonly label: string;
  readonly accessibilityLabel?: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      hitSlop={6}
      onPress={props.onPress}
      className="min-h-9 justify-center self-start active:opacity-70"
    >
      <Text
        className={cn(
          "text-sm font-t3-medium",
          props.disabled ? "text-foreground-muted" : "text-primary-text",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

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
    <View className="gap-1 border-b border-separator py-3">
      {/* Remove shares the name's line, centred on it. */}
      <View className="flex-row items-center gap-3">
        <Text className="min-w-0 flex-1 text-base font-t3-medium text-foreground">
          {seatTitle(seat.seat)}
        </Text>
        <TextAction
          label="Remove"
          accessibilityLabel={`Remove seat ${seat.seat}`}
          disabled={!props.removable}
          onPress={props.onRemove}
        />
      </View>
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
  );
}

function Review(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly proposal: CrewProposal;
  readonly canResolve: boolean;
  /** The Inbox's notice while the server is away; the review stays readable but takes no action. */
  readonly waitsForServer: string | null;
  /** Holds this proposal on screen while this page answers it, and lets go if the answer fails. */
  readonly onAnswering: (held: boolean) => void;
  readonly onResolved: () => void;
}) {
  const { proposal, environmentId } = props;
  const insets = useSafeAreaInsets();
  const [removed, setRemoved] = useState<ReadonlyArray<string>>([]);
  const [fullBrief, setFullBrief] = useState(false);
  const [busy, setBusy] = useState(false);
  const [waitingForPreview, setWaitingForPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seats = removed.reduce(removeSeat, proposal.requestedSeats);
  const preview = useCrewProposalPreview(environmentId, proposal.id, seats, !busy);
  const playbook = preview.data?.playbook ?? proposal.playbook ?? null;
  const titles = (ids: ReadonlyArray<string>) =>
    ids.map((id) => stepTitle(playbook, id)).join(", ");
  const unowned =
    preview.data?.unownedSteps ?? (proposal.kind === "roster" ? unownedSteps(playbook, seats) : []);
  const answering = busy || waitingForPreview;
  // Nothing to approve until a runtime is shown; after that, a re-preview after Remove or
  // Restore keeps Approve as it is, and only a failed preview stops it.
  const canApprove = props.canResolve && !answering && preview.settled && preview.error === null;

  const resolve = async (request: Parameters<typeof resolveCrewProposal>[1]) => {
    setBusy(true);
    props.onAnswering(true);
    setError(null);
    try {
      await resolveCrewProposal(environmentId, request);
      props.onResolved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't answer the Crew proposal.");
      // A token is spent by the attempt; the next approval asks for a fresh preview.
      preview.refresh();
      setBusy(false);
      props.onAnswering(false);
    }
  };
  const approve = (approval: CrewProposalPreviewResponse) =>
    resolve({
      proposalId: proposal.id,
      decision: "approve",
      seats,
      approvalToken: approval.approvalToken,
    });

  // Tapped mid-preview: wait for its token, and use it only if it previews what the person saw.
  const approveWhenPreviewed = async () => {
    const held = { proposalId: proposal.id, seats, runtime: preview.runtime };
    setWaitingForPreview(true);
    const fresh = await preview.next();
    setWaitingForPreview(false);
    // A failed preview shows its own error; one that changed a seat says so.
    if (fresh === null) return;
    if (heldCrewApprovalSends(held, fresh)) await approve(fresh);
    else setError("The runtime changed while it loaded. Check the seats and approve again.");
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
        <TextAction
          label={fullBrief ? "View less" : "View more"}
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
          {/* Seats wait for their runtime, so each appears in its final shape (rubric §3.6). */}
          {preview.settled ? (
            seats.map((seat) => (
              <SeatRow
                key={seat.seat}
                seat={seat}
                runtime={preview.runtime.find((row) => row.seat === seat.seat)}
                runtimeLoading={preview.loading}
                playbook={playbook}
                removable={props.canResolve && !answering && seats.length > 1}
                onRemove={() => setRemoved([...removed, seat.seat])}
              />
            ))
          ) : (
            <Text className="py-3 text-sm text-foreground-muted">Resolving runtime…</Text>
          )}
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
          <TextAction
            label="Restore removed seats"
            disabled={answering}
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
          {props.waitsForServer ??
            (props.canResolve
              ? "To change a seat, ask the Captain in chat, or edit the proposal on web or desktop."
              : "Only someone who can write to the Captain's thread can approve or decline this Crew.")}
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
            disabled={!props.canResolve || answering}
            onPress={() => void resolve({ proposalId: proposal.id, decision: "decline" })}
          />
        </View>
        <View className="flex-1">
          <Button
            label={proposal.kind === "roster" ? "Approve Crew" : "Approve member"}
            tone="primary"
            fullWidth
            loading={answering}
            disabled={!canApprove}
            onPress={() =>
              void (preview.data === null ? approveWhenPreviewed() : approve(preview.data))
            }
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
  const server = useServerConnection(environmentId);
  // Held from this page's own answer to the pop: the list may drop it before the answer returns.
  const [answering, setAnswering] = useState<CrewProposal | null>(null);
  const review = crewProposalReview(query.data, props.route.params.proposalId, answering);
  // Android draws every page's bar in the screen; upstream's route presets hide the native one.
  const header =
    Platform.OS === "android" ? (
      <AppBar title="Crew proposal" onBack={() => navigation.goBack()} />
    ) : (
      <NativeStackScreenOptions options={{ title: "Crew proposal" }} />
    );
  if (review.kind !== "open") {
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
          ) : review.kind === "loading" ? (
            <Text className="text-foreground-muted">Loading the proposal…</Text>
          ) : (
            <EmptyState title="Already answered" detail={review.detail} />
          )}
        </ScreenScrollView>
      </View>
    );
  }
  const { proposal } = review;
  return (
    <>
      {header}
      <Review
        environmentId={environmentId}
        threadId={threadId}
        proposal={proposal}
        canResolve={permitted && writesToCaptain && server.connected}
        waitsForServer={server.connected ? null : askWaitsForServerLine(server.label)}
        onAnswering={(held) => setAnswering(held ? proposal : null)}
        onResolved={() => {
          query.refresh();
          navigation.goBack();
        }}
      />
    </>
  );
}

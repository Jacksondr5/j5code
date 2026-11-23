import { useAtomValue } from "@effect/atom-react";
import {
  mergeCrewRuntimeRequestSources,
  mergeNativeQuestionInboxSources,
} from "@t3tools/client-runtime/j5/crew-inbox-requests";
import {
  askWaitsForServerLine,
  closedLine,
  j5SourceNotice,
  mergeHumanInboxSources,
  type PresentedHumanInboxItem,
} from "@t3tools/client-runtime/j5/inbox";
import { presentParticipantIdentity } from "@t3tools/client-runtime/j5/participant-identity";
import {
  type ScopedWorktreeCleanup,
  worktreeCleanupKey,
} from "@t3tools/client-runtime/j5/crew-worktree-cleanup";
import { spansMultipleEnvironments } from "@t3tools/client-runtime/j5/readSources";
import type { EnvironmentId } from "@t3tools/contracts";
import { scopedInboxItemKey } from "@t3tools/contracts/j5";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { type ComponentProps, forwardRef, useCallback, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { Notice } from "../../components/ui/Notice";
import { useOpenLinkedThread } from "../../features/threads/useOpenLinkedThread";
import { relativeTime } from "../../lib/time";
import { NativeScrollViewMarker } from "../../native/NativeScrollViewMarker";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { j5Sharing } from "../sharing/guestAccess";
import { SenderMarkdown } from "../artifacts/WorkspaceMarkdown";
import { J5Card, J5CardEyebrow, J5LinkCard } from "../components/J5Card";
import { j5Environment } from "../state";
import { AnswerArea } from "./AnswerArea";
import { type ClosedItem, useInboxAnswers } from "./inboxAnswers";
import { AgentQuestionsSection, SeatApprovalsSection } from "./InboxCrewRequests";
import {
  DecidedCleanupRow,
  useWorktreeCleanupInbox,
  WorktreeCleanupsSection,
} from "./InboxWorktreeCleanups";
import { J5RecordPanel } from "./J5RecordPanel";
import {
  answeredInboxQueryAtom,
  answeredInboxSourcesAtom,
  crewRequestSourcesAtom,
  decidedWorktreeCleanupQueryAtom,
  decidedWorktreeCleanupSourcesAtom,
  openInboxQueryAtom,
  openInboxSourcesAtom,
  readInboxSources,
  refreshCrewRequestSources,
  refreshInboxSources,
  worktreeCleanupQueryAtom,
  worktreeCleanupSourcesAtom,
} from "./inboxSources";
import { createPullRefresh } from "./inboxPullRefresh.logic";
import { useScopedParticipantLabels, type ScopedParticipantLabels } from "./senderLabels";

type SenderLabels = ScopedParticipantLabels;

const NO_LABELS: ReadonlyMap<string, string> = new Map();

const URGENCY = {
  blocking: { label: "Blocking", className: "text-danger-foreground" },
  soon: { label: "Soon", className: "text-warning-foreground" },
  fyi: { label: "FYI", className: "text-foreground-muted" },
} as const;

/** Null while the name is on its way, so the line does not swap a stand-in for it. */
const senderName = (item: PresentedHumanInboxItem, labels: SenderLabels) =>
  labels.isPending(item.environmentId, item.senderId)
    ? null
    : presentParticipantIdentity({
        participantId: item.senderId,
        participantLabels: labels.labels.get(item.environmentId) ?? NO_LABELS,
      }).label;

/** The reader's own name on an item's server, so "Priya answered" can read "You answered". */
function useOwnName(environmentId: EnvironmentId): string | null {
  const access = useAtomValue(j5Sharing.connectionAccess(environmentId));
  return access?.kind === "person" ? access.name : null;
}

function refreshAll() {
  refreshInboxSources(openInboxSourcesAtom, openInboxQueryAtom);
  refreshInboxSources(answeredInboxSourcesAtom, answeredInboxQueryAtom);
  refreshInboxSources(worktreeCleanupSourcesAtom, worktreeCleanupQueryAtom);
  refreshInboxSources(decidedWorktreeCleanupSourcesAtom, decidedWorktreeCleanupQueryAtom);
  refreshCrewRequestSources();
}

/**
 * The person's Inbox: what agents on every connected server have asked them, most urgent first
 * (Inbox AC6), answered in place, Crew seats' approvals and agents' questions, an Owner's
 * worktree cleanups, and the asks already answered.
 */
export function InboxScreen() {
  const navigation = useNavigation();
  const openSources = useAtomValue(openInboxSourcesAtom);
  const answeredSources = useAtomValue(answeredInboxSourcesAtom);
  const items = mergeHumanInboxSources(openSources);
  const answered = mergeHumanInboxSources(answeredSources);
  const crewSources = useAtomValue(crewRequestSourcesAtom);
  const seatApprovals = mergeCrewRuntimeRequestSources(crewSources);
  const agentQuestions = mergeNativeQuestionInboxSources(crewSources);
  const cleanupSources = useAtomValue(worktreeCleanupSourcesAtom);
  const decidedCleanupSources = useAtomValue(decidedWorktreeCleanupSourcesAtom);
  const cleanups = useWorktreeCleanupInbox();
  const showEnvironment = spansMultipleEnvironments([
    ...items,
    ...answered,
    ...seatApprovals,
    ...agentQuestions,
    ...cleanups.inPlace,
    ...cleanups.shelf,
  ]);
  const labels = useScopedParticipantLabels(
    [...items, ...answered].map((item) => ({
      environmentId: item.environmentId,
      participantId: item.senderId,
      connected: item.connected,
    })),
  );
  const answers = useInboxAnswers({ openSources, items, answeredSources, answered });
  // Reads again each time the Inbox comes into view; between visits the server's inbox signal
  // rereads it. No timer.
  useFocusEffect(useCallback(() => refreshAll(), []));
  const loading =
    !openSources.isReady || openSources.sources.some((source) => source.status === "loading");
  // The spinner is for a refresh the person asked for: an answer's re-read updates the list quietly.
  const [refreshing, setRefreshing] = useState(false);
  const [pullToRefresh] = useState(() =>
    createPullRefresh({ read: readInboxSources, onChange: setRefreshing }),
  );
  // A connected server whose read is still on its way gets no notice: it would show and leave
  // again within a frame or two as the Inbox opens.
  const notices = new Map(
    [
      ...openSources.sources,
      ...answeredSources.sources,
      ...crewSources.sources,
      ...cleanupSources.sources,
      ...decidedCleanupSources.sources,
    ].flatMap((source) => {
      const notice = source.status === "loading" ? null : j5SourceNotice(source);
      return notice === null ? [] : [[notice, source.status === "offline"] as const];
    }),
  );
  const insets = useSafeAreaInsets();
  const content = (
    <>
      <NativeStackScreenOptions options={{ title: "Inbox" }} />
      {[...notices].map(([notice, offline]) => (
        <Notice
          key={notice}
          message={notice}
          icon={offline ? "wifi.slash" : "exclamationmark.triangle"}
        />
      ))}
      <SeatApprovalsSection requests={seatApprovals} />
      <AgentQuestionsSection questions={agentQuestions} showEnvironment={showEnvironment} />
      {answers.shownItems.length === 0 ? (
        seatApprovals.length > 0 ||
        agentQuestions.length > 0 ||
        cleanups.inPlace.length > 0 ? null : loading ? (
          <Text className="text-foreground-muted">Loading your inbox…</Text>
        ) : (
          <EmptyState
            variant="plain"
            title="Nothing waiting on you"
            detail="When an agent asks you something, it shows up here."
          />
        )
      ) : (
        <View className="gap-3">
          {answers.shownItems.map((item) => {
            const key = scopedInboxItemKey(item);
            return (
              <InboxItem
                key={key}
                item={item}
                labels={labels}
                showEnvironment={showEnvironment}
                closed={answers.closedOf(item)}
                answerText={answers.answerText(item)}
                onChangeAnswer={(text) => answers.setAnswerText(item, text)}
                onAnswer={() => void answers.answer(item)}
                delivering={answers.pendingKey === key}
                error={answers.errorFor(item)}
                anyDelivering={answers.pendingKey !== null}
              />
            );
          })}
        </View>
      )}
      <WorktreeCleanupsSection
        items={cleanups.inPlace}
        pendingKey={cleanups.pendingKey}
        errors={cleanups.errors}
        onAnswer={(item, removePaths) => void cleanups.answer(item, removePaths)}
        showEnvironment={showEnvironment}
      />
      <AnsweredShelf
        items={answered}
        cleanups={cleanups.shelf}
        labels={labels}
        showEnvironment={showEnvironment}
      />
    </>
  );
  const refreshControl = (
    <RefreshControl refreshing={refreshing} onRefresh={() => void pullToRefresh()} />
  );
  // keyboard-controller keeps the focused answer box, and the Answer row below it, clear of the
  // keyboard on both platforms. The offset is measured from the caret, so it spans the rest of an
  // empty box and the row.
  const list = (
    <KeyboardAwareScrollView
      bottomOffset={140}
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-sheet"
      contentContainerClassName="gap-4 px-5 pt-4"
      contentContainerStyle={{
        // Upstream's page bottom padding, and Android's content width cap as ScreenScrollView applies it.
        paddingBottom: Math.max(insets.bottom, 18) + 18,
        ...(Platform.OS === "android" ? { width: "100%", maxWidth: 720, alignSelf: "center" } : {}),
      }}
      keyboardShouldPersistTaps="handled"
      refreshControl={refreshControl}
      {...(Platform.OS === "ios" ? { ScrollViewComponent: InboxScrollView } : {})}
    >
      {content}
    </KeyboardAwareScrollView>
  );
  // Android draws every page's bar in the screen; upstream's route presets hide the native one.
  return Platform.OS === "android" ? (
    <View className="flex-1 bg-sheet">
      <AppBar title="Inbox" onBack={() => navigation.goBack()} />
      {list}
    </View>
  ) : (
    list
  );
}

// iOS registers the screen's scroll view with its header through the marker, which must hold the
// scroll view itself; keyboard-controller wraps its scroll view in a view of its own, so the marker
// goes inside, around the scroll view it renders, as ThreadFeed's does.
const InboxScrollView = forwardRef<Animated.ScrollView, ComponentProps<typeof Animated.ScrollView>>(
  function InboxScrollView(props, ref) {
    return (
      <NativeScrollViewMarker style={{ flex: 1 }}>
        <Animated.ScrollView ref={ref} {...props} />
      </NativeScrollViewMarker>
    );
  },
);

function ItemMeta(props: {
  readonly item: PresentedHumanInboxItem;
  readonly labels: SenderLabels;
  readonly showEnvironment: boolean;
  readonly trailing?: string | null;
  readonly numberOfLines?: number;
}) {
  const { item } = props;
  const parts = [
    senderName(item, props.labels),
    item.projectTitle,
    item.forEveryone === true ? "for everyone here" : null,
    props.showEnvironment || !item.connected
      ? `${props.showEnvironment ? item.environmentLabel : ""}${item.connected ? "" : props.showEnvironment ? " (offline)" : "offline"}`
      : null,
    props.trailing ?? null,
  ].filter((part): part is string => part !== null && part !== "");
  return (
    <Text className="text-xs text-foreground-muted" numberOfLines={props.numberOfLines ?? 2}>
      {parts.join(" · ")}
    </Text>
  );
}

function InboxItem(props: {
  readonly item: PresentedHumanInboxItem;
  readonly labels: SenderLabels;
  readonly showEnvironment: boolean;
  /** The item closed while the person had typed into it, and stays with their words (AC17). */
  readonly closed: ClosedItem | undefined;
  readonly answerText: string;
  readonly onChangeAnswer: (text: string) => void;
  readonly onAnswer: () => void;
  readonly delivering: boolean;
  readonly anyDelivering: boolean;
  /** Why this ask's last answer was not delivered, or a stale list after it was. */
  readonly error: string | null;
}) {
  const { item } = props;
  const [expanded, setExpanded] = useState(false);
  const urgency = URGENCY[item.urgency];
  const ownName = useOwnName(item.environmentId);
  const mayAnswer = useAtomValue(
    j5Environment.answerHumanExchange.permissionAtom(item.environmentId),
  );
  const canAnswer = item.sourceReady && mayAnswer;
  const closedText = props.closed === undefined ? null : closedLine({ ...props.closed, ownName });
  return (
    <J5Card>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${urgency.label}. ${item.intent}`}
        onPress={() => setExpanded(!expanded)}
        className="gap-1"
      >
        <View className="flex-row items-center gap-2">
          <J5CardEyebrow label={urgency.label} className={urgency.className} />
          <View className="flex-1" />
          <SymbolView
            name={expanded ? "chevron.down" : "chevron.right"}
            size={12}
            tintColorClassName="accent-icon-muted"
          />
        </View>
        <Text className="text-base font-t3-bold">{item.intent}</Text>
        <ItemMeta
          item={item}
          labels={props.labels}
          showEnvironment={props.showEnvironment}
          trailing={props.closed === undefined ? `open ${relativeTime(item.openedAt)}` : null}
        />
      </Pressable>
      {expanded ? (
        <View className="mt-3 gap-3 border-t border-border-subtle pt-3">
          <InboxMessage item={item} markdown={item.message} />
          {[item.escalation?.summary, item.personaDraft?.summary].map((record) =>
            record === undefined ? null : <J5RecordPanel key={record} text={record} />,
          )}
          {item.followUps?.map((followUp) => (
            <View className="gap-1" key={followUp.messageId}>
              <Text className="text-xs font-t3-medium text-foreground-muted">Follow-up</Text>
              <InboxMessage item={item} markdown={followUp.message} />
            </View>
          ))}
          {closedText === null && !item.connected ? (
            // Read-only until its server is back; words typed earlier are kept for then.
            <Text className="text-sm text-foreground-muted">
              {askWaitsForServerLine(item.environmentLabel)}
            </Text>
          ) : (
            <AnswerArea
              item={item}
              text={props.answerText}
              onChangeText={props.onChangeAnswer}
              inputStyle={{ minHeight: 96, textAlignVertical: "top" }}
              leading={<OpenSenderThread item={item} />}
              closedText={closedText}
              sending={props.delivering}
              busy={props.anyDelivering && !props.delivering}
              canAnswer={canAnswer}
              onAnswer={props.onAnswer}
            />
          )}
          {props.error === null ? null : (
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              {props.error}
            </Text>
          )}
        </View>
      ) : null}
    </J5Card>
  );
}

/** An ask's words, with its links and images read in the sender's thread, as web reads them. */
function InboxMessage(props: {
  readonly item: PresentedHumanInboxItem;
  readonly markdown: string;
}) {
  return (
    <SenderMarkdown
      markdown={props.markdown}
      environmentId={props.item.environmentId}
      senderThreadId={props.item.senderThreadId}
    />
  );
}

function OpenSenderThread(props: { readonly item: PresentedHumanInboxItem }) {
  const openLinkedThread = useOpenLinkedThread();
  const { item } = props;
  const available = item.connected && item.senderThreadId !== null;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityState={{ disabled: !available }}
      disabled={!available}
      hitSlop={6}
      onPress={() =>
        item.senderThreadId !== null &&
        openLinkedThread({
          environmentId: String(item.environmentId),
          threadId: item.senderThreadId,
        })
      }
      className="min-h-9 shrink justify-center active:opacity-70"
    >
      <Text
        className={`font-t3-medium text-sm ${available ? "text-primary-text" : "text-foreground-muted"}`}
      >
        {available
          ? "Open thread"
          : item.senderThreadId === null
            ? "The sender is no longer in the roster"
            : "Its server is offline"}
      </Text>
    </Pressable>
  );
}

function AnsweredShelf(props: {
  readonly items: ReadonlyArray<PresentedHumanInboxItem>;
  readonly cleanups: ReadonlyArray<ScopedWorktreeCleanup>;
  readonly labels: SenderLabels;
  readonly showEnvironment: boolean;
}) {
  const [open, setOpen] = useState(false);
  const count = props.items.length + props.cleanups.length;
  if (count === 0) return null;
  return (
    <View className="gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        className="flex-row items-center gap-2 py-2"
      >
        <SymbolView
          name={open ? "chevron.down" : "chevron.right"}
          size={12}
          tintColorClassName="accent-icon-muted"
        />
        <Text className="font-t3-medium text-foreground-muted">Answered {count}</Text>
      </Pressable>
      {open
        ? props.items.map((item) => (
            <AnsweredItem
              key={scopedInboxItemKey(item)}
              item={item}
              labels={props.labels}
              showEnvironment={props.showEnvironment}
            />
          ))
        : null}
      {open
        ? props.cleanups.map((item) => (
            <DecidedCleanupRow
              key={worktreeCleanupKey(item)}
              item={item}
              showEnvironment={props.showEnvironment}
            />
          ))
        : null}
    </View>
  );
}

function AnsweredItem(props: {
  readonly item: PresentedHumanInboxItem;
  readonly labels: SenderLabels;
  readonly showEnvironment: boolean;
}) {
  const { item } = props;
  const openLinkedThread = useOpenLinkedThread();
  const ownName = useOwnName(item.environmentId);
  const answerer =
    item.answeredBy === null || item.answeredBy === undefined
      ? null
      : item.answeredBy === ownName
        ? "you"
        : item.answeredBy;
  const answered = answerer === null ? "answered" : `answered by ${answerer}`;
  const { senderThreadId } = item;
  return (
    // The whole card opens the sender's thread; offline, or with the sender gone, it is inert.
    <J5LinkCard
      accessibilityLabel={`Open ${item.intent}`}
      onPress={
        item.connected && senderThreadId !== null
          ? () =>
              openLinkedThread({
                environmentId: String(item.environmentId),
                threadId: senderThreadId,
              })
          : null
      }
    >
      <Text className="text-sm font-t3-medium">{item.intent}</Text>
      <ItemMeta
        item={item}
        labels={props.labels}
        showEnvironment={props.showEnvironment}
        numberOfLines={1}
      />
      <Text className="text-xs text-foreground-muted">
        {item.terminalAt ? `${answered} · ${relativeTime(item.terminalAt)}` : answered}
      </Text>
      {item.connected && senderThreadId === null ? (
        <Text className="text-xs text-foreground-muted">The sender is no longer in the roster</Text>
      ) : null}
    </J5LinkCard>
  );
}

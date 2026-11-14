import { useAtomValue } from "@effect/atom-react";
import {
  mergeCrewRuntimeRequestSources,
  mergeNativeQuestionInboxSources,
} from "@t3tools/client-runtime/j5/crew-inbox-requests";
import { mergeWorktreeCleanupSources } from "@t3tools/client-runtime/j5/crew-worktree-cleanup";
import {
  answeredByLine,
  askWaitsForServerLine,
  closedLine,
  j5SourceNotice,
  mergeHumanInboxSources,
  type PresentedHumanInboxItem,
} from "@t3tools/client-runtime/j5/inbox";
import { presentParticipantIdentity } from "@t3tools/client-runtime/j5/participant-identity";
import { spansMultipleEnvironments } from "@t3tools/client-runtime/j5/readSources";
import type { EnvironmentId } from "@t3tools/contracts";
import { scopedInboxItemKey } from "@t3tools/contracts/j5";
import { useFocusEffect } from "@react-navigation/native";
import { type ComponentProps, forwardRef, useCallback, useState } from "react";
import { Platform, Pressable, RefreshControl, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import Animated from "react-native-reanimated";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { useMarkdownPreviewStyles } from "../../features/files/FileMarkdownPreview";
import { useOpenLinkedThread } from "../../features/threads/useOpenLinkedThread";
import { relativeTime } from "../../lib/time";
import { NativeScrollViewMarker } from "../../native/NativeScrollViewMarker";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { j5Sharing } from "../sharing/guestAccess";
import { j5Environment } from "../state";
import { type ClosedItem, useInboxAnswers } from "./inboxAnswers";
import { AgentQuestionsSection, SeatApprovalsSection } from "./InboxCrewRequests";
import { WorktreeCleanupsSection } from "./InboxWorktreeCleanups";
import { J5RecordPanel } from "./J5RecordPanel";
import {
  answeredInboxQueryAtom,
  answeredInboxSourcesAtom,
  crewRequestSourcesAtom,
  openInboxQueryAtom,
  openInboxSourcesAtom,
  readInboxSources,
  refreshCrewRequestSources,
  refreshInboxSources,
  worktreeCleanupQueryAtom,
  worktreeCleanupSourcesAtom,
} from "./inboxSources";
import { createPullRefresh } from "./inboxPullRefresh.logic";
import { useScopedParticipantLabels } from "./senderLabels";

type SenderLabels = ReadonlyMap<EnvironmentId, ReadonlyMap<string, string>>;

const NO_LABELS: ReadonlyMap<string, string> = new Map();

const URGENCY = {
  blocking: { label: "Blocking", className: "text-danger-foreground" },
  soon: { label: "Soon", className: "text-warning-foreground" },
  fyi: { label: "FYI", className: "text-foreground-muted" },
} as const;

const senderName = (item: PresentedHumanInboxItem, labels: SenderLabels) =>
  presentParticipantIdentity({
    participantId: item.senderId,
    participantLabels: labels.get(item.environmentId) ?? NO_LABELS,
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
  refreshCrewRequestSources();
}

/**
 * The person's Inbox: what agents on every connected server have asked them, most urgent first
 * (Inbox AC6), answered in place, Crew seats' approvals and agents' questions, an Owner's
 * worktree cleanups, and the asks already answered.
 */
export function InboxScreen() {
  const openSources = useAtomValue(openInboxSourcesAtom);
  const answeredSources = useAtomValue(answeredInboxSourcesAtom);
  const items = mergeHumanInboxSources(openSources);
  const answered = mergeHumanInboxSources(answeredSources);
  const crewSources = useAtomValue(crewRequestSourcesAtom);
  const seatApprovals = mergeCrewRuntimeRequestSources(crewSources);
  const agentQuestions = mergeNativeQuestionInboxSources(crewSources);
  const cleanupSources = useAtomValue(worktreeCleanupSourcesAtom);
  const cleanups = mergeWorktreeCleanupSources(cleanupSources);
  const showEnvironment = spansMultipleEnvironments([
    ...items,
    ...answered,
    ...seatApprovals,
    ...agentQuestions,
    ...cleanups,
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
  const notices = [
    ...new Set(
      [
        ...openSources.sources,
        ...answeredSources.sources,
        ...crewSources.sources,
        ...cleanupSources.sources,
      ].flatMap((source) => {
        const notice = j5SourceNotice(source);
        return notice === null ? [] : [notice];
      }),
    ),
  ];
  const content = (
    <>
      <NativeStackScreenOptions options={{ title: "Inbox" }} />
      {notices.map((notice) => (
        <Text key={notice} className="text-sm text-foreground-muted">
          {notice}
        </Text>
      ))}
      <SeatApprovalsSection requests={seatApprovals} />
      <AgentQuestionsSection questions={agentQuestions} showEnvironment={showEnvironment} />
      {answers.shownItems.length === 0 ? (
        seatApprovals.length > 0 ||
        agentQuestions.length > 0 ||
        cleanups.length > 0 ? null : loading ? (
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
      <WorktreeCleanupsSection items={cleanups} showEnvironment={showEnvironment} />
      <AnsweredShelf items={answered} labels={labels} showEnvironment={showEnvironment} />
    </>
  );
  const refreshControl = (
    <RefreshControl refreshing={refreshing} onRefresh={() => void pullToRefresh()} />
  );
  // keyboard-controller keeps the focused answer box, and the Answer row below it, clear of the
  // keyboard on both platforms. The offset is measured from the caret, so it spans the rest of an
  // empty box and the row.
  return (
    <KeyboardAwareScrollView
      bottomOffset={140}
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-sheet"
      contentContainerClassName="gap-4 px-4 py-4"
      // Android's content width cap, as upstream's ScreenScrollView applies it.
      contentContainerStyle={
        Platform.OS === "android"
          ? { width: "100%", maxWidth: 720, alignSelf: "center" }
          : undefined
      }
      keyboardShouldPersistTaps="handled"
      refreshControl={refreshControl}
      {...(Platform.OS === "ios" ? { ScrollViewComponent: InboxScrollView } : {})}
    >
      {content}
    </KeyboardAwareScrollView>
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
    <Text className="text-xs text-foreground-muted" numberOfLines={2}>
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
    <View className="rounded-2xl border-continuous bg-card px-4 py-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${urgency.label}. ${item.intent}`}
        onPress={() => setExpanded(!expanded)}
        className="gap-1"
      >
        <View className="flex-row items-center gap-2">
          <Text className={`text-xs font-t3-semibold uppercase ${urgency.className}`}>
            {urgency.label}
          </Text>
          <View className="flex-1" />
          <SymbolView
            name={expanded ? "chevron.down" : "chevron.right"}
            size={12}
            tintColorClassName="accent-icon-muted"
          />
        </View>
        <Text className="text-base font-t3-semibold">{item.intent}</Text>
        <ItemMeta
          item={item}
          labels={props.labels}
          showEnvironment={props.showEnvironment}
          trailing={props.closed === undefined ? `open ${relativeTime(item.openedAt)}` : null}
        />
      </Pressable>
      {expanded ? (
        <View className="mt-3 gap-3 border-t border-border-subtle pt-3">
          <InboxMessage markdown={item.message} />
          {[item.escalation?.summary, item.personaDraft?.summary].map((record) =>
            record === undefined ? null : <J5RecordPanel key={record} text={record} />,
          )}
          {item.followUps?.map((followUp) => (
            <View className="gap-1" key={followUp.messageId}>
              <Text className="text-xs font-t3-medium text-foreground-muted">Follow-up</Text>
              <InboxMessage markdown={followUp.message} />
            </View>
          ))}
          {closedText === null && !item.connected ? (
            // Read-only until its server is back; words typed earlier are kept for then.
            <Text className="text-sm text-foreground-muted">
              {askWaitsForServerLine(item.environmentLabel)}
            </Text>
          ) : (
            <>
              <TextInput
                accessibilityLabel={`Answer ${item.intent}`}
                multiline
                placeholder="Type the answer exactly as it should be delivered"
                value={props.answerText}
                onChangeText={props.onChangeAnswer}
                style={{ minHeight: 96, textAlignVertical: "top" }}
              />
              <View className="flex-row flex-wrap items-center justify-between gap-2">
                <OpenSenderThread item={item} />
                {closedText !== null ? (
                  <Text className="text-sm text-foreground-muted">{closedText}</Text>
                ) : (
                  <Button
                    label={props.delivering ? "Delivering…" : "Answer"}
                    tone="primary"
                    loading={props.delivering}
                    disabled={!canAnswer || props.anyDelivering || props.answerText.length === 0}
                    accessibilityHint={
                      canAnswer
                        ? undefined
                        : "This server is unavailable or this connection is read-only."
                    }
                    onPress={props.onAnswer}
                  />
                )}
              </View>
            </>
          )}
          {props.error === null ? null : (
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              {props.error}
            </Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

function InboxMessage(props: { readonly markdown: string }) {
  const styles = useMarkdownPreviewStyles();
  return <SelectableMarkdownText markdown={props.markdown} textStyle={styles.nativeTextStyle} />;
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
    >
      <Text
        className={`font-t3-medium text-sm ${available ? "text-foreground-secondary" : "text-foreground-muted"}`}
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
  readonly labels: SenderLabels;
  readonly showEnvironment: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (props.items.length === 0) return null;
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
        <Text className="font-t3-medium text-foreground-muted">Answered {props.items.length}</Text>
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
    </View>
  );
}

function AnsweredItem(props: {
  readonly item: PresentedHumanInboxItem;
  readonly labels: SenderLabels;
  readonly showEnvironment: boolean;
}) {
  const { item } = props;
  const answeredBy = answeredByLine(item.answeredBy, useOwnName(item.environmentId));
  const when = item.terminalAt ? `answered ${relativeTime(item.terminalAt)}` : "answered";
  return (
    <View className="gap-1 rounded-2xl bg-card px-4 py-3">
      <Text className="text-sm font-t3-medium">{item.intent}</Text>
      <ItemMeta
        item={item}
        labels={props.labels}
        showEnvironment={props.showEnvironment}
        trailing={answeredBy === null ? when : `${when} · ${answeredBy}`}
      />
      <OpenSenderThread item={item} />
    </View>
  );
}

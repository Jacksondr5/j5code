import { useAtomValue } from "@effect/atom-react";
import { adjudicationAsks, pickShownAsk } from "@t3tools/client-runtime/j5/adjudication-dock";
import {
  askWaitsForServerLine,
  closedLine,
  mergeHumanInboxSources,
  type PresentedHumanInboxItem,
} from "@t3tools/client-runtime/j5/inbox";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedInboxItemKey } from "@t3tools/contracts/j5";
import { useState } from "react";
import { type LayoutChangeEvent, Pressable, View } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { type DerivedValue, useAnimatedStyle } from "react-native-reanimated";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { relativeTime } from "../../lib/time";
import { SenderMarkdown } from "../artifacts/WorkspaceMarkdown";
import { J5Card, J5CardEyebrow } from "../components/J5Card";
import { AnswerArea } from "../inbox/AnswerArea";
import { useInboxAnswers } from "../inbox/inboxAnswers";
import { answeredInboxSourcesAtom, openInboxSourcesAtom } from "../inbox/inboxSources";
import { J5RecordPanel } from "../inbox/J5RecordPanel";
import { j5Sharing } from "../sharing/guestAccess";
import { j5Environment } from "../state";

/**
 * Two lines of the question stay readable, and scroll, however little room is left (IN-14). More
 * would push the slot under the header once a long title and the agents pill share the room (DL-1).
 */
const QUESTION_MIN_HEIGHT = 42;

const URGENCY = {
  blocking: { label: "Blocking", className: "text-danger-foreground" },
  soon: { label: "Soon", className: "text-warning-foreground" },
  fyi: { label: "FYI", className: "text-foreground-muted" },
} as const;

/**
 * A Captain's open asks to the person, for its thread's carousel: the Inbox's own asks, answered
 * through the same command, so answering here or there closes the one Exchange (Crews:
 * adjudication request). Null when there are none, or this connection may not answer.
 */
export function useCaptainQuestions(environmentId: EnvironmentId, threadId: ThreadId) {
  const openSources = useAtomValue(openInboxSourcesAtom);
  const answeredSources = useAtomValue(answeredInboxSourcesAtom);
  const ofThisEnvironment = (items: ReturnType<typeof mergeHumanInboxSources>) =>
    items.filter((item) => item.environmentId === environmentId);
  const answers = useInboxAnswers({
    openSources,
    items: ofThisEnvironment(mergeHumanInboxSources(openSources)),
    answeredSources,
    answered: ofThisEnvironment(mergeHumanInboxSources(answeredSources)),
  });
  const mayAnswer = useAtomValue(j5Environment.answerHumanExchange.permissionAtom(environmentId));
  const access = useAtomValue(j5Sharing.connectionAccess(environmentId));
  // An ask that closed while the person had typed into it stays, with who answered (Inbox AC17).
  const asks = adjudicationAsks({
    items: answers.shownItems,
    refused: [],
    threadId,
    hasWords: () => true,
  });
  if (!mayAnswer || asks.length === 0) return null;
  return { asks, answers, ownName: access?.kind === "person" ? access.name : null };
}

export type CaptainQuestions = NonNullable<ReturnType<typeof useCaptainQuestions>>;

function UrgencyLabel(props: { readonly lead: string; readonly ask: PresentedHumanInboxItem }) {
  const urgency = URGENCY[props.ask.urgency];
  return (
    <>
      <J5CardEyebrow label={props.lead} />
      <Text className="text-xs text-foreground-muted">·</Text>
      <J5CardEyebrow label={urgency.label} className={urgency.className} />
    </>
  );
}

/** The folded questions card: the most urgent ask, with how many are open in its label (D7). */
export function QuestionsCardFace(props: { readonly questions: CaptainQuestions }) {
  const { asks } = props.questions;
  const first = asks[0]!;
  return (
    <>
      <View className="h-4 flex-row items-center gap-1.5">
        <UrgencyLabel
          lead={asks.length === 1 ? "Question" : `${asks.length} questions`}
          ask={first}
        />
      </View>
      <Text numberOfLines={1} className="text-sm font-t3-medium text-foreground">
        {first.intent}
      </Text>
    </>
  );
}

export const questionsCardLabel = (questions: CaptainQuestions) => {
  const first = questions.asks[0]!;
  const count = questions.asks.length;
  return `${count === 1 ? "Question" : `${count} questions`}, ${URGENCY[first.urgency].label}: ${first.intent}`;
};

/**
 * The opened questions card, in the composer's place: one ask at a time, and a footer that steps
 * to the next, wrapping, so any of them can be answered first (D6). Its question gets the room the
 * rest of the slot leaves, measured, and scrolls within it.
 */
export function QuestionPanel(props: {
  readonly questions: CaptainQuestions;
  /** Upstream's room for its question card, which takes the composer's place as this panel does. */
  readonly maxHeight: DerivedValue<number>;
  readonly composerBottomInset: number;
  /** The slot's measured height above the keyboard, this panel included; 0 until measured. */
  readonly overlayHeight: number;
  readonly onFold: () => void;
  /** Upstream's owned-input focus report, which keeps the slot following the keyboard on Android. */
  readonly onInputFocusChange: (focused: boolean) => void;
}) {
  const { questions, maxHeight, composerBottomInset, overlayHeight } = props;
  const { answers } = questions;
  // Pinned on opening, so an ask that arrives sorted ahead never swaps the question being answered.
  const [picked, setPicked] = useState(() => questions.asks[0]?.exchangeId ?? null);
  const [heights, setHeights] = useState({ question: 0, panel: 0 });
  const measure = (part: keyof typeof heights) => (event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    setHeights((current) => (current[part] === height ? current : { ...current, [part]: height }));
  };
  // The slot's bottom inset hides under the keyboard, which upstream's room doesn't count.
  const { progress: keyboardProgress } = useReanimatedKeyboardAnimation();
  const measured = overlayHeight > 0 && heights.question > 0 && heights.panel > 0;
  const questionStyle = useAnimatedStyle(
    () => ({
      maxHeight: measured
        ? Math.max(
            QUESTION_MIN_HEIGHT,
            heights.question +
              Math.min(
                maxHeight.value +
                  composerBottomInset * (1 + keyboardProgress.value) -
                  overlayHeight,
                // The panel alone never outgrows upstream's room: Android scrolls the slot at that
                // height, and the overlay then stops measuring what it holds.
                maxHeight.value - heights.panel,
              ),
          )
        : QUESTION_MIN_HEIGHT,
    }),
    [measured, heights, composerBottomInset, overlayHeight],
  );
  const view = pickShownAsk(questions.asks, picked);
  // Answered, it falls back to the first still open, which is pinned in turn.
  if (view !== null && view.shown.exchangeId !== picked) setPicked(view.shown.exchangeId);
  if (view === null) return null;
  const { shown, others, next: nextAsk } = view;
  const closed = answers.closedOf(shown);
  const closedText =
    closed === undefined ? null : closedLine({ ...closed, ownName: questions.ownName });
  const delivering = answers.pendingKey !== null;
  const sending = answers.pendingKey === scopedInboxItemKey(shown);
  const markdown = (value: string) => (
    <SenderMarkdown
      markdown={value}
      environmentId={shown.environmentId}
      senderThreadId={shown.senderThreadId}
    />
  );
  const footer = (held: boolean) =>
    nextAsk === null ? null : (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: held }}
        disabled={held}
        onPress={() => setPicked(nextAsk.exchangeId)}
        className="-mb-3 min-h-9 flex-row items-center gap-1 border-t border-border-subtle"
      >
        <Text className="shrink-0 text-xs text-foreground">
          {others.length} more {others.length === 1 ? "question" : "questions"}
        </Text>
        <Text numberOfLines={1} className="min-w-0 flex-1 text-xs text-foreground-muted">
          · {nextAsk.intent}
        </Text>
        <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-muted" />
      </Pressable>
    );

  return (
    <View className="px-4 pb-3" testID="adjudication-dock" onLayout={measure("panel")}>
      <J5Card className="gap-2.5">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: true }}
          accessibilityLabel={`Fold question: ${shown.intent}`}
          onPress={props.onFold}
          className="flex-row items-start gap-2"
        >
          <View className="min-w-0 flex-1 gap-1">
            <View className="flex-row flex-wrap items-center gap-1.5">
              <UrgencyLabel lead="Question" ask={shown} />
              <Text className="text-xs text-foreground-muted">
                · open {relativeTime(shown.openedAt)}
              </Text>
            </View>
            <Text className="text-lg font-t3-bold text-foreground">{shown.intent}</Text>
          </View>
          <View className="h-8 w-8 items-center justify-center rounded-full bg-subtle-strong">
            <SymbolView
              name="chevron.down"
              size={13}
              tintColorClassName="accent-icon-subtle"
              type="monochrome"
            />
          </View>
        </Pressable>
        <Animated.ScrollView
          key={shown.exchangeId}
          // Hidden, not removed, until the room is measured, so no frame shows it unsized.
          style={[questionStyle, measured ? null : { opacity: 0 }]}
          nestedScrollEnabled
          onLayout={measure("question")}
        >
          <View className="gap-2">
            {markdown(shown.message)}
            {[shown.escalation?.summary, shown.personaDraft?.summary].map((record) =>
              record === undefined ? null : <J5RecordPanel key={record} text={record} />,
            )}
            {shown.followUps?.map((followUp) => (
              <View className="gap-1" key={followUp.messageId}>
                <Text className="text-xs font-t3-medium text-foreground-muted">Follow-up</Text>
                {markdown(followUp.message)}
              </View>
            ))}
          </View>
        </Animated.ScrollView>
        {closedText === null && !shown.connected ? (
          <>
            {/* Read-only until its server is back, as in the Inbox; typed words wait for then. */}
            <Text className="text-sm text-foreground-muted">
              {askWaitsForServerLine(shown.environmentLabel)}
            </Text>
            {footer(false)}
          </>
        ) : (
          <AnswerArea
            key={`answer:${shown.exchangeId}`}
            item={shown}
            text={answers.answerText(shown)}
            onChangeText={(value) => answers.setAnswerText(shown, value)}
            inputStyle={{ minHeight: 64, maxHeight: 120, textAlignVertical: "top" }}
            closedText={closedText}
            sending={sending}
            busy={delivering && !sending}
            canAnswer={shown.sourceReady}
            error={answers.errorFor(shown)}
            onAnswer={() => void answers.answer(shown)}
            onFocusChange={props.onInputFocusChange}
            footer={footer}
          />
        )}
      </J5Card>
    </View>
  );
}

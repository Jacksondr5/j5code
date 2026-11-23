import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { commandsACrew } from "@t3tools/client-runtime/j5/adjudication-dock";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useLayoutEffect, useState } from "react";
import Animated, {
  type DerivedValue,
  FadeInDown,
  FadeOut,
  ReduceMotion,
  runOnJS,
  type SharedValue,
  useAnimatedReaction,
} from "react-native-reanimated";

import {
  type CaptainQuestions,
  QuestionPanel,
  QuestionsCardFace,
  questionsCardLabel,
  useCaptainQuestions,
} from "../a2a/CaptainQuestions";
import { useCrewMembership } from "../crew/crewMemberships";
import { RosterGateFace, useRosterGates } from "../crew/RosterGateCard";
import {
  PlaybookCardFace,
  playbookCardLabel,
  PlaybookSteps,
  usePlaybookCard,
} from "../playbooks/PlaybookCard";
import {
  AttentionCarousel,
  type CarouselCard,
  ROW_ENTERING,
  ROW_EXITING,
} from "./AttentionCarousel";
import type { J5ComposerSlot } from "./composerSlot";

/** Upstream's question card opens and folds with these. */
const PANEL_ENTERING = FadeInDown.duration(220).reduceMotion(ReduceMotion.System);
const PANEL_EXITING = FadeOut.duration(140).reduceMotion(ReduceMotion.System);

interface Props {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Upstream's `pendingUserInputMaxHeight`: the room its question card gets in the composer's place. */
  readonly maxHeight: DerivedValue<number>;
  /** Upstream's `composerBottomInset`, which its room takes off even under the keyboard. */
  readonly composerBottomInset: number;
  /** The open composer popover's height, 0 while none is open. */
  readonly popoverHeight: SharedValue<number>;
  readonly slot: J5ComposerSlot;
  /** Upstream's `handleOwnedInputFocusChange`, which its own question card reports to as well. */
  readonly onAnswerFocusChange: (focused: boolean) => void;
}

/**
 * J5's one row above a thread's composer (area 2): a carousel of what needs the person, in order
 * questions, Crew proposals, then the running Playbook. At most one card is open at a time, alone
 * in the row; the open questions card takes the composer's place.
 */
export function J5ComposerControls(props: Props) {
  const membership = useCrewMembership(scopeThreadRef(props.environmentId, props.threadId));
  // The Inbox is read only for a Captain's thread.
  return commandsACrew(membership) ? (
    <CaptainControls {...props} />
  ) : (
    <Controls {...props} questions={null} />
  );
}

function CaptainControls(props: Props) {
  return (
    <Controls {...props} questions={useCaptainQuestions(props.environmentId, props.threadId)} />
  );
}

function Controls(props: Props & { readonly questions: CaptainQuestions | null }) {
  const { questions, slot } = props;
  const navigation = useNavigation();
  const gates = useRosterGates(props.environmentId, props.threadId);
  const playbook = usePlaybookCard(props.environmentId, props.threadId);
  const [questionsFocused, setQuestionsFocused] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  useAnimatedReaction(
    () => props.popoverHeight.value > 0,
    (open, previous) => {
      if (open !== previous) runOnJS(setPopoverOpen)(open);
    },
  );
  // Asks answered elsewhere close the panel for good, so a later ask arrives folded.
  if (questionsFocused && questions === null) setQuestionsFocused(false);
  const questionsOpen = questionsFocused && questions !== null;
  // A composer popover folds the steps and hides the row while it's open, so no card shows beside
  // or above a short one (AC-13).
  const playbookOpen = playbook !== null && playbook.expanded && !questionsOpen && !popoverOpen;
  const setPlaybookExpanded = (expanded: boolean) => playbook?.setExpanded(expanded);

  const { setHidesComposer } = slot;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the thread screen hides upstream's composer while the panel holds its place, before paint, and gets it back when the panel or this row goes
  useLayoutEffect(() => {
    setHidesComposer(questionsOpen);
    return () => setHidesComposer(false);
  }, [questionsOpen, setHidesComposer]);

  // A question that wasn't there before takes the row back to the questions card. An open panel
  // isn't pulled away: the row shows that card once the person folds it.
  const askIds = questions?.asks.map((ask) => ask.exchangeId) ?? [];
  const [seenAskIds, setSeenAskIds] = useState(askIds);
  const [pageKey, setPageKey] = useState<string | null>(null);
  if (askIds.some((id) => !seenAskIds.includes(id))) {
    setSeenAskIds(askIds);
    setPageKey("questions");
  }

  const cards: Array<CarouselCard> = [];
  if (questions !== null)
    cards.push({
      key: "questions",
      accessibilityLabel: questionsCardLabel(questions),
      onPress: () => {
        setPlaybookExpanded(false);
        setQuestionsFocused(true);
      },
      face: <QuestionsCardFace questions={questions} />,
    });
  for (const gate of gates)
    cards.push({
      key: `proposal:${gate.id}`,
      accessibilityLabel: `${gate.title}: ${gate.name}, ${gate.count}. Review`,
      onPress: () =>
        navigation.navigate("ThreadCrewProposal", {
          environmentId: props.environmentId,
          threadId: props.threadId,
          proposalId: gate.id,
        }),
      face: <RosterGateFace gate={gate} />,
    });
  if (playbook !== null)
    cards.push({
      key: "playbook",
      accessibilityLabel: playbookCardLabel(playbook),
      onPress: () => {
        setQuestionsFocused(false);
        setPlaybookExpanded(true);
      },
      face: <PlaybookCardFace card={playbook} />,
    });
  // The row holds on to the card it shows, so a card added ahead never takes its place; when the
  // shown card leaves, the row shows the first.
  const shownKey = cards.some((card) => card.key === pageKey) ? pageKey : (cards[0]?.key ?? null);
  if (shownKey !== pageKey) setPageKey(shownKey);

  if (questionsOpen)
    return (
      <Animated.View key="questions-panel" entering={PANEL_ENTERING} exiting={PANEL_EXITING}>
        <QuestionPanel
          questions={questions}
          maxHeight={props.maxHeight}
          composerBottomInset={props.composerBottomInset}
          overlayHeight={slot.overlayHeight}
          onFold={() => setQuestionsFocused(false)}
          onInputFocusChange={props.onAnswerFocusChange}
        />
      </Animated.View>
    );
  if (playbookOpen)
    return (
      <Animated.View key="playbook-steps" entering={PANEL_ENTERING} exiting={PANEL_EXITING}>
        <PlaybookSteps card={playbook} onFold={() => setPlaybookExpanded(false)} />
      </Animated.View>
    );
  if (cards.length === 0) return null;
  return (
    <Animated.View
      key="carousel"
      entering={ROW_ENTERING}
      exiting={ROW_EXITING}
      // Under an open popover, kept in place but unseen, so no neighbour peeks out beside it (AC-13).
      style={popoverOpen ? { opacity: 0 } : undefined}
      pointerEvents={popoverOpen ? "none" : "auto"}
    >
      <AttentionCarousel cards={cards} shownKey={shownKey} onShownChange={setPageKey} />
    </Animated.View>
  );
}

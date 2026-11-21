import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  asks: [] as Array<{ exchangeId: string }>,
  gates: [] as Array<{ id: string; title: string; name: string; count: string }>,
}));

vi.mock("react-native", () => ({ View: "View", Pressable: "Pressable" }));
vi.mock("react-native-reanimated", () => {
  const motion = { duration: () => motion, reduceMotion: () => motion };
  return {
    default: { View: "AnimatedView" },
    FadeInDown: motion,
    FadeOut: motion,
    ReduceMotion: { System: "system" },
    runOnJS: (fn: unknown) => fn,
    useAnimatedReaction: () => undefined,
  };
});
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock("./AttentionCarousel", () => ({
  AttentionCarousel: "AttentionCarousel",
  ROW_ENTERING: {},
  ROW_EXITING: {},
}));
vi.mock("../crew/crewMemberships", () => ({
  useCrewMembership: () => ({ kind: "captain", crews: [{}] }),
}));
vi.mock("../crew/RosterGateCard", () => ({
  useRosterGates: () => harness.gates,
  RosterGateFace: "Face",
}));
vi.mock("../a2a/CaptainQuestions", () => ({
  useCaptainQuestions: () => (harness.asks.length === 0 ? null : { asks: harness.asks }),
  QuestionPanel: "QuestionPanel",
  QuestionsCardFace: "Face",
  questionsCardLabel: () => "Questions",
}));
vi.mock("../playbooks/PlaybookCard", async () => {
  const { useState } = await import("react");
  return {
    usePlaybookCard: () => {
      const [view, setView] = useState({ expanded: false, selectedRunId: null });
      return { view, setView };
    },
    PlaybookCardFace: "Face",
    PlaybookSteps: "PlaybookSteps",
    playbookCardLabel: () => "Playbook",
  };
});

import { J5ComposerControls } from "./J5ComposerControls";

let renderer: ReactTestRenderer;
const render = () => (
  <J5ComposerControls
    environmentId={EnvironmentId.make("env")}
    threadId={ThreadId.make("captain")}
    maxHeight={{ value: 400 } as never}
    composerBottomInset={20}
    popoverHeight={{ value: 0 } as never}
    slot={{ overlayHeight: 0, setHidesComposer: () => undefined }}
    onAnswerFocusChange={() => undefined}
  />
);
const carousel = () => renderer.root.findByType("AttentionCarousel" as never);

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness.asks = [{ exchangeId: "first" }];
  harness.gates = [];
  await act(async () => {
    renderer = create(render());
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

it("leaves the expanded Playbook open when a question arrives, and shows the questions card once it folds", async () => {
  await act(async () => carousel().props.onShownChange("playbook"));
  const playbookCard = carousel().props.cards.find(
    (card: { key: string }) => card.key === "playbook",
  );
  await act(async () => playbookCard.onPress());
  const steps = () => renderer.root.findAllByType("PlaybookSteps" as never);
  expect(steps()).toHaveLength(1);

  harness.asks = [{ exchangeId: "first" }, { exchangeId: "second" }];
  await act(async () => renderer.update(render()));
  expect(steps()).toHaveLength(1);

  await act(async () => steps()[0]!.props.onFold());
  expect(carousel().props.shownKey).toBe("questions");
});

it("keeps a lone Playbook card shown when a proposal arrives ahead of it", async () => {
  harness.asks = [];
  await act(async () => renderer.update(render()));
  expect(carousel().props.shownKey).toBe("playbook");

  harness.gates = [{ id: "p1", title: "Crew proposal", name: "Review", count: "2 members" }];
  await act(async () => renderer.update(render()));
  expect(carousel().props.cards.map((card: { key: string }) => card.key)).toEqual([
    "proposal:p1",
    "playbook",
  ]);
  expect(carousel().props.shownKey).toBe("playbook");
});

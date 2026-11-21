import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  scrollTo: vi.fn<(options: { x: number; animated: boolean }) => void>(),
  frames: [] as Array<() => void>,
}));

vi.mock("react-native", () => ({ View: "View", Pressable: "Pressable" }));
vi.mock("react-native-reanimated", async () => {
  const { createElement, forwardRef, useImperativeHandle } = await import("react");
  const motion = { duration: () => motion, reduceMotion: () => motion };
  const ScrollView = forwardRef((props: Record<string, unknown>, ref) => {
    useImperativeHandle(ref, () => ({ scrollTo: harness.scrollTo }));
    return createElement("ScrollView", props);
  });
  return {
    default: { View: "AnimatedView", ScrollView },
    FadeInDown: motion,
    FadeOut: motion,
    ReduceMotion: { System: "system" },
    LayoutAnimationConfig: "LayoutAnimationConfig",
  };
});
vi.mock("../components/J5Card", () => ({ J5_CARD_CHROME: "" }));

import { AttentionCarousel } from "./AttentionCarousel";
import { carouselCardWidth, carouselOffsets } from "./carouselLayout";

const cards = ["questions", "proposal", "playbook"].map((key) => ({
  key,
  accessibilityLabel: key,
  onPress: () => undefined,
  face: null,
}));
const render = (shownKey: string) => (
  <AttentionCarousel cards={cards} shownKey={shownKey} onShownChange={() => undefined} />
);

let renderer: ReactTestRenderer;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (frame: () => void) => harness.frames.push(frame));
  harness.scrollTo.mockClear();
  harness.frames = [];
  await act(async () => {
    renderer = create(render("questions"));
  });
  await act(async () =>
    renderer.root
      .findByProps({ testID: "j5-attention-carousel" })
      .props.onLayout({ nativeEvent: { layout: { width: 402 } } }),
  );
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

it("re-places the card shown when the deferred frame runs, not the one shown when the row widened", async () => {
  await act(async () =>
    renderer.root.findByType("ScrollView" as never).props.onContentSizeChange(),
  );
  await act(async () => renderer.update(render("playbook")));
  await act(async () => harness.frames.splice(0).forEach((frame) => frame()));

  const playbook = carouselOffsets(3, carouselCardWidth(402, 3))[2];
  expect(harness.scrollTo).toHaveBeenLastCalledWith({ x: playbook, animated: false });
});

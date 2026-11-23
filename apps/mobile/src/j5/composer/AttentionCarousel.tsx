import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { type NativeScrollEvent, type NativeSyntheticEvent, Pressable, View } from "react-native";
import Animated, {
  FadeInDown,
  FadeOut,
  LayoutAnimationConfig,
  ReduceMotion,
} from "react-native-reanimated";

import { J5_CARD_CHROME } from "../components/J5Card";
import {
  CAROUSEL_GAP,
  CAROUSEL_INSET,
  carouselCardWidth,
  carouselOffsets,
  nearestCard,
} from "./carouselLayout";

/** Upstream's rows above the composer fade like this; J5's rows follow them (MG-3). */
export const ROW_ENTERING = FadeInDown.duration(180).reduceMotion(ReduceMotion.System);
export const ROW_EXITING = FadeOut.duration(120).reduceMotion(ReduceMotion.System);

/** The folded card's chrome: J5's card set at the folded question bar's 47.5 pt. */
const FOLDED_CARD = `${J5_CARD_CHROME} h-[47.5px] justify-center px-4`;

export interface CarouselCard {
  readonly key: string;
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
  readonly face: ReactNode;
}

/**
 * J5's one row of attention cards above the composer, exactly one card tall. It pages one card per
 * swipe; a single card takes the full width and doesn't page.
 */
export function AttentionCarousel(props: {
  readonly cards: ReadonlyArray<CarouselCard>;
  /** The card on screen, by key; the first card when it isn't in the row. */
  readonly shownKey: string | null;
  readonly onShownChange: (key: string) => void;
}) {
  const { cards } = props;
  const [width, setWidth] = useState(0);
  const scroll = useRef<Animated.ScrollView>(null);
  const count = cards.length;
  const page = Math.max(
    0,
    cards.findIndex((card) => card.key === props.shownKey),
  );
  const shownKey = cards[page]?.key ?? null;
  const cardWidth = carouselCardWidth(width, count);
  const offsets = carouselOffsets(count, cardWidth);
  const offset = offsets[page] ?? 0;
  const placed = useRef(shownKey);
  const placedOffset = useRef(offset);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the native scroll view: at once, before paint, when cards around the shown one change; animated when the row moves to another card
  useLayoutEffect(() => {
    const paging = placed.current !== shownKey;
    placed.current = shownKey;
    placedOffset.current = offset;
    scroll.current?.scrollTo({ x: offset, animated: paging });
  }, [offset, shownKey]);
  const settle = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const index = nearestCard(offsets, event.nativeEvent.contentOffset.x);
    const key = cards[index]?.key;
    if (key !== undefined && key !== shownKey) {
      // The swipe already put it there.
      placed.current = key;
      placedOffset.current = offsets[index] ?? 0;
      props.onShownChange(key);
    }
  };
  return (
    <View
      className="pb-3"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      testID="j5-attention-carousel"
    >
      <Animated.ScrollView
        ref={scroll}
        horizontal
        scrollEnabled={count > 1}
        showsHorizontalScrollIndicator={false}
        snapToOffsets={offsets}
        decelerationRate="fast"
        disableIntervalMomentum
        onMomentumScrollEnd={settle}
        // A card added ahead widens the row after the scroll above, which the old width clamped.
        // Android's horizontal scroll view takes the new width a frame after it reports it.
        onContentSizeChange={() =>
          requestAnimationFrame(() =>
            scroll.current?.scrollTo({ x: placedOffset.current, animated: false }),
          )
        }
        contentContainerStyle={{ paddingHorizontal: CAROUSEL_INSET, gap: CAROUSEL_GAP }}
      >
        {width === 0 ? null : (
          // The row fades in as a whole; only cards that arrive later fade in on their own.
          <LayoutAnimationConfig skipEntering>
            {cards.map((card) => (
              <Animated.View
                key={card.key}
                entering={ROW_ENTERING}
                exiting={ROW_EXITING}
                style={{ width: cardWidth }}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={card.accessibilityLabel}
                  onPress={card.onPress}
                  className={`${FOLDED_CARD} active:opacity-70`}
                >
                  {card.face}
                </Pressable>
              </Animated.View>
            ))}
          </LayoutAnimationConfig>
        )}
      </Animated.ScrollView>
      {/* Holds the row's height before its width is known, so nothing below it moves. */}
      {width === 0 ? <View className="mx-4 h-[47.5px]" /> : null}
    </View>
  );
}

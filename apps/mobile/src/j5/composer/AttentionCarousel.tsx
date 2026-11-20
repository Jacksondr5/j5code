import { type ReactNode, useEffect, useRef, useState } from "react";
import { type NativeScrollEvent, type NativeSyntheticEvent, Pressable, View } from "react-native";
import Animated, { FadeInDown, FadeOut, ReduceMotion } from "react-native-reanimated";

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
export const FOLDED_CARD =
  "h-[47.5px] justify-center rounded-[20px] border border-foreground/15 bg-card-alt px-4";

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
  readonly page: number;
  readonly onPageChange: (page: number) => void;
}) {
  const { cards, page } = props;
  const [width, setWidth] = useState(0);
  const scroll = useRef<Animated.ScrollView>(null);
  const count = cards.length;
  const cardWidth = carouselCardWidth(width, count);
  const offsets = carouselOffsets(count, cardWidth);
  const offset = offsets[Math.min(page, count - 1)] ?? 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the native scroll view when a card is added before the shown one or a new question takes the row back to the first card
  useEffect(() => {
    scroll.current?.scrollTo({ x: offset, animated: true });
  }, [offset]);
  const settle = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const index = nearestCard(offsets, event.nativeEvent.contentOffset.x);
    if (index !== page) props.onPageChange(index);
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
        contentContainerStyle={{ paddingHorizontal: CAROUSEL_INSET, gap: CAROUSEL_GAP }}
      >
        {width === 0
          ? null
          : cards.map((card) => (
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
      </Animated.ScrollView>
      {/* Holds the row's height before its width is known, so nothing below it moves. */}
      {width === 0 ? <View className="mx-4 h-[47.5px]" /> : null}
    </View>
  );
}

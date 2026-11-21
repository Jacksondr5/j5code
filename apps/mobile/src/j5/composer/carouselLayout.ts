export const CAROUSEL_INSET = 14;
export const CAROUSEL_GAP = 8;
/** A card with neighbours is this much narrower than the row, so 10 pt of each neighbour shows. */
const PEEK_ROOM = 22;

/** A single card takes the row less its insets; with neighbours, it leaves room for their peeks. */
export const carouselCardWidth = (rowWidth: number, count: number) =>
  Math.max(0, rowWidth - (count === 1 ? CAROUSEL_INSET * 2 : CAROUSEL_INSET + PEEK_ROOM));

/**
 * Where the row rests on each card: the first card at the left inset, the last at the right inset,
 * and a middle card centred, so a neighbour peeks on each side that has one.
 */
export function carouselOffsets(count: number, cardWidth: number): ReadonlyArray<number> {
  const shift = PEEK_ROOM - CAROUSEL_INSET;
  return Array.from({ length: count }, (_, index) => {
    const start = index * (cardWidth + CAROUSEL_GAP);
    if (index === 0) return 0;
    return index === count - 1 ? start - shift : start - shift / 2;
  });
}

/** The card a swipe settled on. */
export const nearestCard = (offsets: ReadonlyArray<number>, x: number) =>
  offsets.reduce(
    (best, offset, index) => (Math.abs(offset - x) < Math.abs(offsets[best]! - x) ? index : best),
    0,
  );

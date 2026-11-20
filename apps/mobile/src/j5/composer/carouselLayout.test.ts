import { expect, it } from "vite-plus/test";

import { carouselCardWidth, carouselOffsets, nearestCard } from "./carouselLayout";

it("rests the first card at the left inset, a middle card centred and the last at the right inset", () => {
  const row = 402;
  const card = carouselCardWidth(row, 3);
  expect(card).toBe(366);
  const offsets = carouselOffsets(3, card);
  // Each card's left edge on screen: 14 pt for the first, 18 pt (10 pt peeks) for the middle,
  // and 22 pt for the last, which leaves the 14 pt inset on its right.
  expect(offsets.map((offset, index) => 14 + index * (card + 8) - offset)).toEqual([14, 18, 22]);
  expect(14 + 2 * (card + 8) - offsets[2]! + card).toBe(row - 14);
});

it("gives a single card the full width and nowhere to page", () => {
  expect(carouselCardWidth(402, 1)).toBe(374);
  expect(carouselOffsets(1, 374)).toEqual([0]);
});

it("settles a swipe on the nearest card", () => {
  const offsets = carouselOffsets(3, 366);
  expect(nearestCard(offsets, 0)).toBe(0);
  expect(nearestCard(offsets, 300)).toBe(1);
  expect(nearestCard(offsets, 900)).toBe(2);
});

/**
 * A one-way route between two points, drawn as a quadratic curve. The peering
 * page marks each direct route with chevrons that point at the receiver, and
 * flies its messages along the same curve.
 */
export interface Route {
  from: [number, number];
  control: [number, number];
  to: [number, number];
}

export const routePath = ({ from, control, to }: Route) =>
  `M${from[0]} ${from[1]} Q ${control[0]} ${control[1]} ${to[0]} ${to[1]}`;

/**
 * One path of chevrons spaced `gap` apart along the route, pointing from its
 * start to its end. They keep `inset` clear of both ends, where two lanes
 * sharing a mast would overlap.
 */
export function routeChevrons({ from, control, to }: Route, gap = 12, size = 3, inset = gap) {
  const at = (t: number) => {
    const u = 1 - t;
    return [
      u * u * from[0] + 2 * u * t * control[0] + t * t * to[0],
      u * u * from[1] + 2 * u * t * control[1] + t * t * to[1],
    ] as const;
  };
  const steps = 400;
  const n = (v: number) => v.toFixed(1);
  let d = "";
  let travelled = 0;
  let next = inset;
  let prev = at(0);
  const lengths: number[] = [0];
  const points = [prev];
  for (let i = 1; i <= steps; i++) {
    const point = at(i / steps);
    travelled += Math.hypot(point[0] - prev[0], point[1] - prev[1]);
    lengths.push(travelled);
    points.push(point);
    prev = point;
  }
  for (let i = 1; i <= steps && next <= travelled - inset; i++) {
    if (lengths[i]! < next) continue;
    const [x, y] = points[i]!;
    const [px, py] = points[i - 1]!;
    const length = Math.hypot(x - px, y - py) || 1;
    const tx = ((x - px) / length) * size;
    const ty = ((y - py) / length) * size;
    d += `M${n(x - tx / 2 - ty)} ${n(y - ty / 2 + tx)}L${n(x + tx / 2)} ${n(y + ty / 2)}L${n(x - tx / 2 + ty)} ${n(y - ty / 2 - tx)}`;
    next += gap;
  }
  return d;
}

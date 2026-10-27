/** A point on a rounded rectangle's outline, walked clockwise from the top edge's start. */
export type PathPoint = { x: number; y: number; direction: 'right' | 'down' | 'left' | 'up' };

export const roundedRectPerimeter = (width: number, height: number, radius: number): number => {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  return 2 * (width - 2 * r) + 2 * (height - 2 * r) + 2 * Math.PI * r;
};

export function pointOnRoundedRect(width: number, height: number, radius: number, distance: number): PathPoint {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const total = roundedRectPerimeter(width, height, r);
  let s = ((distance % total) + total) % total;
  const top = width - 2 * r;
  const side = height - 2 * r;
  const arc = (Math.PI * r) / 2;
  const corner = (cx: number, cy: number, start: number, direction: PathPoint['direction']): PathPoint => {
    const angle = start + (s / (arc || 1)) * (Math.PI / 2);
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle), direction };
  };
  if (s < top) return { x: r + s, y: 0, direction: 'right' };
  s -= top;
  if (s < arc) return corner(width - r, r, -Math.PI / 2, 'right');
  s -= arc;
  if (s < side) return { x: width, y: r + s, direction: 'down' };
  s -= side;
  if (s < arc) return corner(width - r, height - r, 0, 'down');
  s -= arc;
  if (s < top) return { x: width - r - s, y: height, direction: 'left' };
  s -= top;
  if (s < arc) return corner(r, height - r, Math.PI / 2, 'left');
  s -= arc;
  if (s < side) return { x: 0, y: height - r - s, direction: 'up' };
  s -= side;
  return corner(r, r, Math.PI, 'up');
}

/** A hop between two points: eased travel plus an arc that peaks mid-flight. */
export type Point2 = { x: number; y: number };

export function hopPosition(from: Point2, to: Point2, progress: number, lift: number): Point2 {
  const p = Math.min(1, Math.max(0, progress));
  const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
  return { x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased - 4 * lift * p * (1 - p) };
}

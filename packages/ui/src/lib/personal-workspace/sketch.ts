import type { SketchElement } from './model';

/**
 * Sketch geometry, kept outside the canvas component so the shortcuts the
 * editor relies on are testable without a DOM. The eraser, the move tool and
 * the live preview all share one definition of where a drawn element is.
 */

const width = 1000;
const height = 650;
type Point = readonly [number, number];

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const round = (value: number) => Math.round(value * 100) / 100;
const at = ([x, y]: Point) => `${round(x)},${round(y)}`;

const distanceToSegment = (x: number, y: number, [ax, ay]: Point, [bx, by]: Point) => {
  const dx = bx - ax; const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : clamp(((x - ax) * dx + (y - ay) * dy) / length, 0, 1);
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
};

const distanceToPolyline = (x: number, y: number, points: readonly Point[], closed = false) => {
  if (points.length === 1) return Math.hypot(x - points[0][0], y - points[0][1]);
  let best = Infinity;
  const segments = closed ? points.length : points.length - 1;
  for (let index = 0; index < segments; index++) best = Math.min(best, distanceToSegment(x, y, points[index], points[(index + 1) % points.length]));
  return best;
};

/** The outline the ellipse actually paints, sampled densely enough to measure against. */
const ellipseOutline = (cx: number, cy: number, rx: number, ry: number): Point[] =>
  Array.from({ length: 64 }, (_, index) => {
    const angle = (index / 64) * Math.PI * 2;
    return [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)];
  });

/**
 * Midpoint smoothing: a quadratic through each interior point that ends at the
 * midpoint toward the next one, then a straight closing line. Two points stay
 * the exact straight line readers drew. A single point has no path length at
 * all, so it returns null; the renderer draws an ink dot instead.
 */
export function penPathD(points: readonly Point[]): string | null {
  if (points.length < 2) return null;
  const parts = [`M${at(points[0])}`];
  for (let index = 1; index < points.length - 1; index++) {
    const midpoint: Point = [(points[index][0] + points[index + 1][0]) / 2, (points[index][1] + points[index + 1][1]) / 2];
    parts.push(`Q${at(points[index])} ${at(midpoint)}`);
  }
  parts.push(`L${at(points[points.length - 1])}`);
  return parts.join(' ');
}

/**
 * Forgiving hit test shared by the eraser and the move tool. Precision is a
 * pointing-device problem, not a reader problem, so the slop grows with the
 * stroke width and never falls below a comfortable margin.
 */
export function elementHit(element: SketchElement, [x, y]: Point): boolean {
  const slop = Math.max(10, element.width / 2 + 6);
  const [startX, startY] = element.points[0];
  const [endX, endY] = element.points.at(-1) ?? element.points[0];
  if (element.tool === 'rectangle') {
    return x >= Math.min(startX, endX) - slop && x <= Math.max(startX, endX) + slop
      && y >= Math.min(startY, endY) - slop && y <= Math.max(startY, endY) + slop;
  }
  if (element.tool === 'ellipse') {
    const cx = (startX + endX) / 2; const cy = (startY + endY) / 2;
    const rx = Math.abs(endX - startX) / 2; const ry = Math.abs(endY - startY) / 2;
    // The radius-inflated ellipse covers the interior; the sampled outline
    // catches the painted stroke where inflating radii alone under-reaches.
    if (((x - cx) / (rx + slop)) ** 2 + ((y - cy) / (ry + slop)) ** 2 <= 1) return true;
    return distanceToPolyline(x, y, ellipseOutline(cx, cy, rx, ry), true) <= slop;
  }
  if (element.tool === 'text') {
    const fontSize = element.width * 5 + 12;
    const textWidth = element.text.length * fontSize * 0.55;
    const textHeight = fontSize * 1.3;
    const inBox = x >= startX - slop && x <= startX + textWidth + slop
      && y >= startY - fontSize - slop && y <= startY + textHeight - fontSize + slop;
    return inBox || Math.hypot(x - startX, y - startY) <= slop;
  }
  return distanceToPolyline(x, y, element.points) <= slop;
}

/** Clamp a translation to the canvas bounds, the same as the drawn element. */
export function translateElement(element: SketchElement, dx: number, dy: number): SketchElement {
  return { ...element, points: element.points.map(([x, y]) => [clamp(x + dx, 0, width), clamp(y + dy, 0, height)] as [number, number]) };
}

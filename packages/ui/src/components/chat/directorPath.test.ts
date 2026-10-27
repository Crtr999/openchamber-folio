import { expect, test } from 'bun:test';
import { hopPosition, pointOnRoundedRect, roundedRectPerimeter } from './directorPath';

test('the walk starts on the top edge and goes clockwise around the frame', () => {
  const w = 400, h = 120, r = 20;
  expect(pointOnRoundedRect(w, h, r, 0)).toEqual({ x: r, y: 0, direction: 'right' });
  expect(pointOnRoundedRect(w, h, r, 100).direction).toBe('right');
  const total = roundedRectPerimeter(w, h, r);
  const onRight = pointOnRoundedRect(w, h, r, (w - 2 * r) + (Math.PI * r) / 2 + 10);
  expect(onRight.direction).toBe('down'); expect(onRight.x).toBe(w);
  expect(pointOnRoundedRect(w, h, r, total / 2 + 1).direction).toBe('left');
  expect(pointOnRoundedRect(w, h, r, total - 5).direction).toBe('up');
});

test('the walk is continuous, wraps, and never leaves the frame', () => {
  const w = 300, h = 90, r = 16, total = roundedRectPerimeter(w, h, r);
  let previous = pointOnRoundedRect(w, h, r, 0);
  for (let s = 2; s <= total + 40; s += 2) {
    const next = pointOnRoundedRect(w, h, r, s);
    expect(Math.hypot(next.x - previous.x, next.y - previous.y)).toBeLessThan(3);
    expect(next.x).toBeGreaterThanOrEqual(-0.001); expect(next.x).toBeLessThanOrEqual(w + 0.001);
    expect(next.y).toBeGreaterThanOrEqual(-0.001); expect(next.y).toBeLessThanOrEqual(h + 0.001);
    previous = next;
  }
  expect(pointOnRoundedRect(w, h, r, total + 7)).toEqual(pointOnRoundedRect(w, h, r, 7));
});

test('a hop starts and ends exactly on its points and rises in between', () => {
  const from = { x: 0, y: 100 }, to = { x: 200, y: 100 };
  expect(hopPosition(from, to, 0, 60)).toEqual(from);
  expect(hopPosition(from, to, 1, 60)).toEqual(to);
  expect(hopPosition(from, to, 0.5, 60).y).toBeLessThan(100 - 40);
});

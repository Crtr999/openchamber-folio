import { describe, expect, test } from 'bun:test';
import { elementHit, penPathD, translateElement } from './sketch';
import { sketchElementSvg } from './exports';
import type { SketchElement } from './model';

const element = (tool: SketchElement['tool'], points: SketchElement['points'], width = 4, text = ''): SketchElement => ({ id: 'test', tool, points, color: '#ffffff', width, text });

describe('sketch hit testing', () => {
  test('pen strokes forgive a near miss but not a far one', () => {
    const stroke = element('pen', [[100, 100], [200, 100]]);
    expect(elementHit(stroke, [150, 100])).toBe(true);
    // The default width of 4 gives a 10-unit slop: 8 units off still hits…
    expect(elementHit(stroke, [150, 108])).toBe(true);
    // …while 30 units off is a clear miss.
    expect(elementHit(stroke, [150, 130])).toBe(false);
  });
  test('the slop grows with the stroke width', () => {
    expect(elementHit(element('pen', [[100, 100], [200, 100]], 4), [150, 114])).toBe(false);
    expect(elementHit(element('pen', [[100, 100], [200, 100]], 20), [150, 114])).toBe(true);
  });
  test('a single-point dot is hit near its ink', () => {
    const dot = element('pen', [[50, 50]]);
    expect(elementHit(dot, [50, 55])).toBe(true);
    expect(elementHit(dot, [50, 80])).toBe(false);
  });
  test('rectangles are hit inside, on the edge margin, and never far outside', () => {
    const rect = element('rectangle', [[100, 100], [200, 150]]);
    expect(elementHit(rect, [150, 125])).toBe(true); // interior
    expect(elementHit(rect, [150, 157])).toBe(true); // 7 past the edge
    expect(elementHit(rect, [150, 180])).toBe(false); // 30 away
  });
  test('ellipses are hit in the interior and near the painted outline', () => {
    const ellipse = element('ellipse', [[100, 100], [220, 160]]);
    expect(elementHit(ellipse, [160, 130])).toBe(true); // centre
    expect(elementHit(ellipse, [100, 130])).toBe(true); // on the left vertex
    expect(elementHit(ellipse, [160, 200])).toBe(false); // well below
  });
  test('text is hit in its estimated box and at its anchor', () => {
    const text = element('text', [[100, 100]], 4, 'Hello');
    expect(elementHit(text, [140, 110])).toBe(true); // inside the estimated box
    expect(elementHit(text, [95, 100])).toBe(true); // within slop of the anchor
    expect(elementHit(text, [100, 150])).toBe(false); // far below the baseline
  });
  test('translation clamps to the canvas bounds', () => {
    expect(translateElement(element('pen', [[10, 10], [990, 640]]), -50, 30).points).toEqual([[0, 40], [940, 650]]);
  });
});

describe('penPathD smoothing', () => {
  test('a single point has no path; the renderer draws a dot instead', () => {
    expect(penPathD([[5, 5]])).toBeNull();
    expect(penPathD([])).toBeNull();
  });
  test('two points stay the exact straight line', () => {
    expect(penPathD([[10, 10], [30, 40]])).toBe('M10,10 L30,40');
  });
  test('three or more points use midpoint quadratics and a closing line', () => {
    expect(penPathD([[0, 0], [10, 20], [20, 0]])).toBe('M0,0 Q10,20 15,10 L20,0');
    expect(penPathD([[0, 0], [10, 10], [20, 0], [30, 10]])).toBe('M0,0 Q10,10 15,5 Q20,0 25,5 L30,10');
  });
  test('coordinates round to two decimals', () => {
    expect(penPathD([[1.239, 2.561], [3.333, 4.444]])).toBe('M1.24,2.56 L3.33,4.44');
  });
});

describe('sketchElementSvg ink visibility', () => {
  test('a single tap renders a visible dot instead of a zero-length path', () => {
    const svg = sketchElementSvg(element('pen', [[40, 60]], 8));
    expect(svg).toContain('<circle');
    expect(svg).toContain('cx="40"');
    expect(svg).toContain('cy="60"');
    expect(svg).toContain('r="4"');
    expect(svg).not.toContain('<path');
  });
  test('a single-point line is a dot too', () => {
    expect(sketchElementSvg(element('line', [[10, 10]], 4))).toContain('<circle');
  });
  test('multi-point pens use the smoothed path', () => {
    const svg = sketchElementSvg(element('pen', [[0, 0], [10, 20], [20, 0]]));
    expect(svg).toContain('d="M0,0 Q10,20 15,10 L20,0"');
  });
});

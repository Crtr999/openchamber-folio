import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';

// React detects input-event support when its DOM renderer is first imported.
// Give that probe a document, then restore the caller's globals immediately —
// otherwise a dispatched `input` event never reaches React's onChange.
const probe = new Window({ url: 'http://localhost' });
const probeNames = ['window', 'document'] as const;
const probeDescriptors = probeNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: probe, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: probe.document, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
for (const [name, descriptor] of probeDescriptors) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
probe.close();

const dom = new Window({ url: 'http://localhost' });
const names = ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'SVGElement', 'DOMPoint', 'PointerEvent', 'MouseEvent', 'KeyboardEvent', 'Event', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const descriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement,
  Element: dom.Element, Node: dom.Node, SVGElement: dom.SVGElement, DOMPoint: dom.DOMPoint, PointerEvent: dom.PointerEvent,
  MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent, Event: dom.Event, getComputedStyle: dom.getComputedStyle.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
});

// happy-dom's DOMPoint has no matrixTransform, and the editor maps every
// pointer through it. An identity transform keeps canvas units equal to client
// coordinates so tests can address the canvas directly.
Object.defineProperty(dom.DOMPoint.prototype, 'matrixTransform', {
  configurable: true,
  writable: true,
  value: function (this: { x: number; y: number }, matrix: { a: number; b: number; c: number; d: number; e: number; f: number }) {
    return { x: matrix.a * this.x + matrix.c * this.y + matrix.e, y: matrix.b * this.x + matrix.d * this.y + matrix.f };
  },
});

const { I18nProvider } = await import('@/lib/i18n');
const { SketchEditor } = await import('./SketchEditor');
const { createArtifact } = await import('@/lib/personal-workspace/model');
import type { SketchElement, WorkspaceArtifact } from '@/lib/personal-workspace/model';

type Drawing = Extract<WorkspaceArtifact, { kind: 'sketch' }>;
const stroke = (id: string, points: SketchElement['points']): SketchElement => ({ id, tool: 'pen', points, color: '#ffffff', width: 4, text: '' });

describe('sketch canvas interaction', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let changes: Drawing[];
  let value: Drawing;
  const canvas = () => {
    const svg = host.querySelector('svg');
    if (!svg) throw new Error('Missing sketch canvas');
    return svg;
  };
  const previewMarkup = () => {
    const groups = host.querySelectorAll('g');
    return groups[groups.length - 1]?.innerHTML ?? '';
  };
  const pointer = async (type: string, clientX: number, clientY: number, options: { pointerId?: number; buttons?: number } = {}) => {
    await act(async () => canvas().dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, isPrimary: true, pointerId: options.pointerId ?? 1, clientX, clientY, buttons: options.buttons ?? 1 })));
  };
  const selectTool = async (label: string) => {
    const button = [...host.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === label);
    if (!button) throw new Error(`Missing ${label} tool`);
    await act(async () => { button.click(); });
  };
  const labelInput = () => {
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Text"]');
    if (!input) throw new Error('Missing text label input');
    return input;
  };
  const typeLabel = async (text: string) => {
    const setValue = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set;
    if (!setValue) throw new Error('Missing input value setter');
    await act(async () => { setValue.call(labelInput(), text); labelInput().dispatchEvent(new Event('input', { bubbles: true })); });
  };
  const render = async () => {
    await act(async () => root.render(<I18nProvider><SketchEditor value={value} onChange={(next) => changes.push(next)} /></I18nProvider>));
    // happy-dom has no real capture model; the editor treats capture as
    // optional, and these stubs mirror the resize-handle tests.
    let captured: number | undefined;
    Object.defineProperties(canvas(), {
      setPointerCapture: { configurable: true, value: (id: number) => { captured = id; } },
      releasePointerCapture: { configurable: true, value: () => { captured = undefined; } },
      hasPointerCapture: { configurable: true, value: (id: number) => captured === id },
    });
  };

  beforeEach(() => {
    changes = [];
    value = createArtifact('sketch', 'Test') as Drawing;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  afterAll(() => {
    dom.close();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  test('a pen drag commits exactly one multi-point element and clears the preview', async () => {
    await render();
    await pointer('pointerdown', 100, 100);
    await pointer('pointermove', 140, 120);
    await pointer('pointerup', 140, 120);
    expect(changes.length).toBe(1);
    const [drawn] = changes[0].elements;
    expect(drawn.tool).toBe('pen');
    expect(drawn.points.length).toBeGreaterThan(1);
    expect(drawn.points[0]).toEqual([100, 100]);
    expect(drawn.points.at(-1)).toEqual([140, 120]);
    expect(previewMarkup()).toBe('');
  });

  test('a move without the primary button held and no active gesture still writes nothing', async () => {
    await render();
    await pointer('pointermove', 200, 200, { buttons: 0 });
    expect(previewMarkup()).toBe('');
    await pointer('pointerup', 200, 200);
    expect(changes.length).toBe(0);
  });

  test('a second pointer is ignored mid-gesture', async () => {
    await render();
    await pointer('pointerdown', 100, 100, { pointerId: 1 });
    await pointer('pointermove', 400, 400, { pointerId: 2 });
    await pointer('pointermove', 150, 150, { pointerId: 1 });
    await pointer('pointerup', 150, 150, { pointerId: 1 });
    expect(changes.length).toBe(1);
    expect(changes[0].elements[0].points).toEqual([[100, 100], [150, 150]]);
  });

  test('a line drag shorter than the minimum extent is dropped without a change', async () => {
    await render();
    await selectTool('Line');
    await pointer('pointerdown', 100, 100);
    await pointer('pointermove', 101, 101);
    await pointer('pointerup', 101, 101);
    expect(changes.length).toBe(0);
    await pointer('pointerdown', 100, 100);
    await pointer('pointermove', 160, 100);
    await pointer('pointerup', 160, 100);
    expect(changes.length).toBe(1);
    expect(changes[0].elements[0].points).toEqual([[100, 100], [160, 100]]);
  });

  test('lost capture abandons the gesture without committing', async () => {
    await render();
    await pointer('pointerdown', 100, 100);
    await pointer('pointermove', 140, 120);
    await act(async () => canvas().dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 1 })));
    expect(changes.length).toBe(0);
    expect(previewMarkup()).toBe('');
  });

  test('the eraser removes a stroke hit within reach, not only on the ink', async () => {
    value.elements = [stroke('stroke', [[100, 100], [200, 100]])];
    await render();
    await selectTool('Eraser');
    await pointer('pointerdown', 150, 107); // 7 units off a 4-wide stroke
    await pointer('pointerup', 150, 107);
    expect(changes.length).toBe(1);
    expect(changes[0].elements).toEqual([]);
  });

  test('one eraser drag across two strokes is a single change', async () => {
    value.elements = [stroke('top', [[100, 100], [200, 100]]), stroke('bottom', [[100, 200], [200, 200]])];
    await render();
    await selectTool('Eraser');
    await pointer('pointerdown', 150, 104);
    await pointer('pointermove', 150, 204);
    await pointer('pointerup', 150, 204);
    expect(changes.length).toBe(1);
    expect(changes[0].elements).toEqual([]);
  });

  test('an empty text click focuses the label field instead of doing nothing', async () => {
    await render();
    await selectTool('Text');
    const input = labelInput();
    input.blur();
    expect(document.activeElement).not.toBe(input);
    await pointer('pointerdown', 300, 300);
    await pointer('pointerup', 300, 300);
    expect(document.activeElement).toBe(input);
    expect(input.className).toContain('animate-pulse');
    expect(changes.length).toBe(0);
  });

  test('a non-empty label is placed immediately and the field refocuses for the next one', async () => {
    await render();
    await selectTool('Text');
    await typeLabel('Hello');
    await pointer('pointerdown', 320, 240);
    await pointer('pointerup', 320, 240);
    expect(changes.length).toBe(1);
    const [placed] = changes[0].elements;
    expect(placed.tool).toBe('text');
    expect(placed.text).toBe('Hello');
    expect(placed.points).toEqual([[320, 240]]);
    expect(labelInput().value).toBe('');
    expect(document.activeElement).toBe(labelInput());
  });

  test('a text click at the 2000-element cap is dropped, and at 1999 the same action still places', async () => {
    value.elements = Array.from({ length: 2000 }, (_, index) => stroke(`stroke-${index}`, [[100, 100]]));
    await render();
    await selectTool('Text');
    await typeLabel('Cap');
    await pointer('pointerdown', 320, 240);
    await pointer('pointerup', 320, 240);
    expect(changes.length).toBe(0);

    value.elements = value.elements.slice(0, 1999);
    await render();
    await typeLabel('Cap');
    await pointer('pointerdown', 320, 240);
    await pointer('pointerup', 320, 240);
    expect(changes.length).toBe(1);
    expect(changes[0].elements.length).toBe(2000);
    expect(changes[0].elements.at(-1)?.tool).toBe('text');
  });

  test('a release while still moving commits the stroke even when no pointerup arrives', async () => {
    await render();
    await pointer('pointerdown', 100, 100);
    await pointer('pointermove', 140, 120);
    await pointer('pointermove', 180, 140, { buttons: 0 });
    expect(changes.length).toBe(1);
    const [drawn] = changes[0].elements;
    expect(drawn.tool).toBe('pen');
    expect(drawn.points[0]).toEqual([100, 100]);
    expect(drawn.points.at(-1)).toEqual([180, 140]);
    expect(previewMarkup()).toBe('');
  });

  test('the pointerup that follows a mid-motion release does not commit a second time', async () => {
    await render();
    await pointer('pointerdown', 100, 100);
    await pointer('pointermove', 140, 120);
    await pointer('pointermove', 180, 140, { buttons: 0 });
    expect(changes.length).toBe(1);
    await pointer('pointerup', 180, 140);
    expect(changes.length).toBe(1);
  });
});

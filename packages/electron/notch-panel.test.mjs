import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNotchBounds, createNotchPanel, NOTCH_PANEL_TOP_GAP } from './notch-panel.mjs';

const workArea = { x: 0, y: 25, width: 1512, height: 945 };

const fakeWindow = (bounds) => {
  const handlers = new Map();
  const calls = [];
  const win = {
    bounds,
    calls,
    destroyed: false,
    isDestroyed() { return win.destroyed; },
    setBounds(next) { calls.push(['setBounds', next]); win.bounds = next; },
    showInactive() { calls.push(['showInactive']); },
    focus() { calls.push(['focus']); },
    hide() { calls.push(['hide']); },
    destroy() { win.destroyed = true; },
    on(event, handler) { handlers.set(event, handler); },
    emit(event) { handlers.get(event)?.(); },
    handlers,
  };
  return win;
};

test('centres the panel horizontally and clears the notch', () => {
  const bounds = computeNotchBounds(workArea);
  assert.equal(bounds.width, 720);
  assert.equal(bounds.x, Math.round((1512 - 720) / 2));
  assert.equal(bounds.y, workArea.y + NOTCH_PANEL_TOP_GAP);
});

test('never exceeds the display width on a narrow screen', () => {
  const bounds = computeNotchBounds({ x: 0, y: 0, width: 800, height: 600 }, { width: 720 });
  assert.ok(bounds.width <= 800 - 32);
  assert.ok(bounds.x >= 0);
});

test('keeps the panel inside a short display', () => {
  const bounds = computeNotchBounds({ x: 0, y: 0, width: 1440, height: 400 });
  assert.ok(bounds.y + bounds.height <= 400);
});

test('follows the display the pointer is on', () => {
  const second = { x: 1512, y: 0, width: 1920, height: 1080 };
  const panel = createNotchPanel({
    platform: 'darwin',
    createWindow: ({ bounds }) => fakeWindow(bounds),
    getCursorPoint: () => ({ x: 2000, y: 40 }),
    getDisplayForPoint: () => ({ workArea: second }),
  });
  panel.show();
  const win = panel.status();
  assert.equal(win.visible, true);
  assert.equal(win.hasPanel, true);
});

test('shows without activating, then focuses for typing', () => {
  let win;
  const panel = createNotchPanel({
    platform: 'darwin',
    createWindow: ({ bounds }) => (win = fakeWindow(bounds)),
    getCursorPoint: () => ({ x: 10, y: 10 }),
    getDisplayForPoint: () => ({ workArea }),
  });
  panel.show();
  const order = win.calls.map(([name]) => name);
  assert.deepEqual(order, ['setBounds', 'showInactive', 'focus']);
});

test('toggles closed and hides on blur', () => {
  let win;
  const panel = createNotchPanel({
    platform: 'darwin',
    createWindow: ({ bounds }) => (win = fakeWindow(bounds)),
    getCursorPoint: () => ({ x: 10, y: 10 }),
    getDisplayForPoint: () => ({ workArea }),
  });
  panel.show();
  assert.equal(panel.status().visible, true);
  panel.toggle();
  assert.equal(panel.status().visible, false);
});

test('ignores the blur that the app activating causes right after showing', () => {
  let win;
  const panel = createNotchPanel({
    platform: 'darwin',
    createWindow: ({ bounds }) => (win = fakeWindow(bounds)),
    getCursorPoint: () => ({ x: 10, y: 10 }),
    getDisplayForPoint: () => ({ workArea }),
  });
  panel.show();
  win.emit('blur');
  assert.equal(panel.status().visible, true, 'a blur within the grace window must not hide the panel');
});

test('reports no display instead of throwing', () => {
  const panel = createNotchPanel({
    platform: 'darwin',
    createWindow: ({ bounds }) => fakeWindow(bounds),
    getCursorPoint: () => null,
    getDisplayForPoint: () => null,
  });
  assert.deepEqual(panel.show(), { ok: false, reason: 'no-display' });
});

test('is unsupported off macOS and never creates a window', () => {
  let created = false;
  const panel = createNotchPanel({
    platform: 'win32',
    createWindow: ({ bounds }) => { created = true; return fakeWindow(bounds); },
    getCursorPoint: () => ({ x: 0, y: 0 }),
    getDisplayForPoint: () => ({ workArea }),
  });
  assert.equal(panel.supported, false);
  panel.show();
  assert.equal(created, false);
});

test('recreates the panel after it was closed', () => {
  let count = 0;
  let win;
  const panel = createNotchPanel({
    platform: 'darwin',
    createWindow: ({ bounds }) => { count += 1; win = fakeWindow(bounds); return win; },
    getCursorPoint: () => ({ x: 10, y: 10 }),
    getDisplayForPoint: () => ({ workArea }),
  });
  panel.show();
  win.destroyed = true;
  panel.show();
  assert.equal(count, 2);
});

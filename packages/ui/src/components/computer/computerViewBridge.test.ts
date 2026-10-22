import { describe, expect, test } from 'bun:test';

import {
  COMPUTER_CLIPBOARD_CONSOLE_PREFIX,
  clampComputerPan,
  clampComputerZoom,
  computeAnchoredZoomTransform,
  parseComputerClipboardConsoleMessage,
  stepComputerZoom,
} from './computerViewBridge';

describe('computerViewBridge zoom and pan math', () => {
  test('clamps zoom to [1, 5] and snaps near-1 values back to fit', () => {
    expect(clampComputerZoom(0.5)).toBe(1);
    expect(clampComputerZoom(1.005)).toBe(1);
    expect(clampComputerZoom(2.25)).toBe(2.25);
    expect(clampComputerZoom(9)).toBe(5);
  });

  test('steps through preset zoom levels in both directions', () => {
    expect(stepComputerZoom(1, 1)).toBe(1.25);
    expect(stepComputerZoom(1.25, 1)).toBe(1.5);
    expect(stepComputerZoom(1.5, -1)).toBe(1.25);
    expect(stepComputerZoom(1, -1)).toBe(1);
  });

  test('clamps pan bounds to [0, size * (zoom - 1)] and resets at 1x', () => {
    expect(clampComputerPan(100, 100, 640, 400, 1)).toEqual({ panX: 0, panY: 0 });
    expect(clampComputerPan(-50, 9999, 640, 400, 2)).toEqual({ panX: 0, panY: 400 });
  });

  test('keeps the focal point locked under the cursor when zooming in and resets at 1x', () => {
    const zoomed = computeAnchoredZoomTransform({
      width: 640,
      height: 400,
      currentZoom: 1,
      nextZoom: 2,
      panX: 0,
      panY: 0,
      localX: 320,
      localY: 200,
    });
    expect(zoomed).toEqual({ zoom: 2, panX: 320, panY: 200 });

    const reset = computeAnchoredZoomTransform({
      width: 640,
      height: 400,
      currentZoom: 2,
      nextZoom: 1,
      panX: 320,
      panY: 200,
      localX: 320,
      localY: 200,
    });
    expect(reset).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });
});

describe('parseComputerClipboardConsoleMessage', () => {
  test('parses valid clipboard bridge messages and ignores unrelated logs', () => {
    expect(parseComputerClipboardConsoleMessage('unrelated log')).toBeNull();
    expect(
      parseComputerClipboardConsoleMessage(
        `${COMPUTER_CLIPBOARD_CONSOLE_PREFIX}${JSON.stringify({
          action: 'paste',
          screen: 'applicant',
          text: 'Hello from Mac',
        })}`,
      ),
    ).toEqual({
      action: 'paste',
      screen: 'applicant',
      text: 'Hello from Mac',
    });
  });
});

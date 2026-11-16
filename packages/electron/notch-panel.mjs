/**
 * Notch panel: a frameless chat surface that lives at the top of the screen,
 * tucked under the MacBook notch, and slides down when summoned.
 *
 * The panel is a normal BrowserWindow with no frame and a transparent body, so
 * the renderer owns the rounded shape. It stays hidden until asked for, never
 * takes focus on creation, and hides again on blur or Escape so it behaves like
 * a menu-bar surface rather than a second app window.
 *
 * Geometry is derived from the display the pointer is on, so it follows the
 * active screen on a multi-display setup. Nothing here reads app content.
 */

export const NOTCH_PANEL_WIDTH = 720;
export const NOTCH_PANEL_HEIGHT = 560;
/** Space between the top of the screen and the panel, clearing the notch. */
export const NOTCH_PANEL_TOP_GAP = 34;

/**
 * Where the panel should sit on a display, in screen coordinates.
 * `workArea` is the display's usable area; the panel is centred horizontally
 * and pinned just below the notch.
 */
export function computeNotchBounds(workArea, { width = NOTCH_PANEL_WIDTH, height = NOTCH_PANEL_HEIGHT, topGap = NOTCH_PANEL_TOP_GAP } = {}) {
  if (!workArea || !Number.isFinite(workArea.x) || !Number.isFinite(workArea.y)
    || !Number.isFinite(workArea.width) || !Number.isFinite(workArea.height)) {
    throw new Error('A display work area is required');
  }
  const panelWidth = Math.min(width, Math.max(320, workArea.width - 32));
  const panelHeight = Math.min(height, Math.max(240, workArea.height - topGap - 16));
  const x = Math.round(workArea.x + (workArea.width - panelWidth) / 2);
  const y = Math.round(workArea.y + topGap);
  return { x, y, width: Math.round(panelWidth), height: Math.round(panelHeight) };
}

/**
 * Owns one notch panel window. `createWindow` is injected so the geometry and
 * visibility rules can be tested without Electron.
 */
export function createNotchPanel({
  createWindow,
  getDisplayForPoint,
  getCursorPoint,
  platform = process.platform,
  width = NOTCH_PANEL_WIDTH,
  height = NOTCH_PANEL_HEIGHT,
} = {}) {
  let panel = null;
  let visible = false;
  let shownAt = 0;
  /** Blur right after showing is usually the app activating, not the user
   *  dismissing the panel; ignore it for a moment so the panel stays open. */
  const BLUR_GRACE_MS = 250;

  const supported = platform === 'darwin';

  const resolveBounds = () => {
    const point = typeof getCursorPoint === 'function' ? getCursorPoint() : null;
    const display = point && typeof getDisplayForPoint === 'function' ? getDisplayForPoint(point) : null;
    const workArea = display?.workArea;
    if (!workArea) return null;
    return computeNotchBounds(workArea, { width, height });
  };

  const ensurePanel = () => {
    if (!supported) return null;
    if (panel && !panel.isDestroyed()) return panel;
    const bounds = resolveBounds();
    if (!bounds) return null;
    panel = createWindow({ bounds });
    visible = false;
    panel.on('blur', () => {
      if (!visible) return;
      if (Date.now() - shownAt < BLUR_GRACE_MS) return;
      hide();
    });
    panel.on('closed', () => {
      panel = null;
      visible = false;
    });
    return panel;
  };

  const show = () => {
    if (!supported) return { ok: false, reason: 'unsupported' };
    const target = ensurePanel();
    if (!target) return { ok: false, reason: 'no-display' };
    const bounds = resolveBounds();
    if (bounds) target.setBounds(bounds);
    // A menu-bar surface must not steal the whole desktop: show without
    // activating, then take focus so typing works immediately.
    target.showInactive();
    target.focus();
    visible = true;
    shownAt = Date.now();
    return { ok: true };
  };

  const hide = () => {
    if (panel && !panel.isDestroyed()) panel.hide();
    visible = false;
    return { ok: true };
  };

  const toggle = () => (visible ? hide() : show());

  return {
    supported,
    status: () => ({ supported, visible, hasPanel: Boolean(panel && !panel.isDestroyed()) }),
    show,
    hide,
    toggle,
    dispose: () => {
      if (panel && !panel.isDestroyed()) panel.destroy();
      panel = null;
      visible = false;
    },
  };
}

export const COMPUTER_CLIPBOARD_CONSOLE_PREFIX = '__OC_COMPUTER_CLIPBOARD__:';

export const MIN_COMPUTER_ZOOM = 1;
export const MAX_COMPUTER_ZOOM = 5;
export const COMPUTER_ZOOM_STEPS = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5] as const;

export type ComputerClipboardConsolePayload = {
  action: 'paste' | 'sync' | 'paste-from-host' | 'copy';
  screen: string;
  text?: string;
};

export const clampComputerZoom = (scale: number): number => {
  if (!Number.isFinite(scale) || scale < 1.01) return MIN_COMPUTER_ZOOM;
  return Math.min(MAX_COMPUTER_ZOOM, Math.max(MIN_COMPUTER_ZOOM, scale));
};

export const stepComputerZoom = (scale: number, direction: 1 | -1): number => {
  const current = clampComputerZoom(scale);
  if (direction === 1) {
    return COMPUTER_ZOOM_STEPS.find((step) => step > current * 1.01) ?? MAX_COMPUTER_ZOOM;
  }
  return [...COMPUTER_ZOOM_STEPS].reverse().find((step) => step < current * 0.99) ?? MIN_COMPUTER_ZOOM;
};

export const clampComputerPan = (
  panX: number,
  panY: number,
  width: number,
  height: number,
  zoom: number,
) => {
  const clampedZoom = clampComputerZoom(zoom);
  if (clampedZoom <= 1) return { panX: 0, panY: 0 };
  const maxPanX = Math.max(0, width * (clampedZoom - 1));
  const maxPanY = Math.max(0, height * (clampedZoom - 1));
  return {
    panX: Math.max(0, Math.min(maxPanX, Number.isFinite(panX) ? panX : 0)),
    panY: Math.max(0, Math.min(maxPanY, Number.isFinite(panY) ? panY : 0)),
  };
};

export const computeAnchoredZoomTransform = (params: {
  width: number;
  height: number;
  currentZoom: number;
  nextZoom: number;
  panX: number;
  panY: number;
  localX: number;
  localY: number;
}) => {
  const { width, height, currentZoom, nextZoom, panX, panY, localX, localY } = params;
  const clampedNext = clampComputerZoom(nextZoom);
  if (clampedNext <= 1) {
    return { zoom: 1, panX: 0, panY: 0 };
  }
  const lx = Math.max(0, Math.min(width, localX));
  const ly = Math.max(0, Math.min(height, localY));
  const screenOffsetX = lx * currentZoom - panX;
  const screenOffsetY = ly * currentZoom - panY;
  const rawPanX = lx * clampedNext - screenOffsetX;
  const rawPanY = ly * clampedNext - screenOffsetY;
  const clampedPan = clampComputerPan(rawPanX, rawPanY, width, height, clampedNext);
  return {
    zoom: clampedNext,
    panX: clampedPan.panX,
    panY: clampedPan.panY,
  };
};

export const parseComputerClipboardConsoleMessage = (
  message: string,
): ComputerClipboardConsolePayload | null => {
  if (typeof message !== 'string' || !message.startsWith(COMPUTER_CLIPBOARD_CONSOLE_PREFIX)) {
    return null;
  }
  try {
    const raw = JSON.parse(message.slice(COMPUTER_CLIPBOARD_CONSOLE_PREFIX.length)) as Partial<ComputerClipboardConsolePayload> | null;
    if (!raw || typeof raw !== 'object') return null;
    const action = raw.action;
    const screen = typeof raw.screen === 'string' ? raw.screen.trim() : '';
    if (!screen) return null;
    if (action !== 'paste' && action !== 'sync' && action !== 'paste-from-host' && action !== 'copy') {
      return null;
    }
    return {
      action,
      screen,
      ...(typeof raw.text === 'string' ? { text: raw.text } : {}),
    };
  } catch {
    return null;
  }
};

/**
 * Injected into the Computer `<webview>` on `dom-ready`.
 *
 * Keeps the `<iframe>` and `#noVNC_container` completely static (no CSS
 * `transform` or `will-change` on the `<iframe>`, avoiding Chromium GuestView
 * compositor layer clipping artifacts and noVNC `ResizeObserver` loops) and
 * sizes/positions the inner `#noVNC_canvas` directly while updating
 * `UI.rfb._display._scale` so pointer coordinates stay 100% native.
 */
export const COMPUTER_VIEW_ENHANCEMENT_SCRIPT = `(() => {
  window.__OC_HOST_HANDLES_PASTE__ = true;
  if (window.__OC_COMPUTER_ENHANCED_V4__) return true;
  window.__OC_COMPUTER_ENHANCED_V4__ = true;
  window.__OC_COMPUTER_ENHANCED__ = true;

  const suppressResizeObserverError = (win) => {
    if (!win || win.__ocRoErrorSuppressed) return;
    win.__ocRoErrorSuppressed = true;
    win.addEventListener('error', (e) => {
      const msg = String(e?.message || e?.error?.message || '');
      if (/^ResizeObserver loop (limit exceeded|completed with undelivered notifications[.]?)$/.test(msg)) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    }, true);
  };
  suppressResizeObserverError(window);

  const style = document.createElement('style');
  style.textContent = \`
    .screen { display:flex; flex-direction:column; overflow:hidden !important; background:#000; }
    .screen .bar { display:flex; align-items:center; gap:6px; flex:none; background:var(--panel, #16181d); }
    .screen .bar b { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .screen .bar .zoom-group { display:inline-flex; align-items:center; gap:2px; background:#111318; border:1px solid var(--line, #262a31); border-radius:7px; padding:1px; }
    .screen .bar .zoom-group button { border:0; background:transparent; padding:3px 7px; font-size:12px; border-radius:5px; color:var(--dim, #9aa1ad); cursor:pointer; }
    .screen .bar .zoom-group button:hover { color:var(--text, #e7e9ee); background:#232730; }
    .screen .bar .zoom-group .zoom-pct { min-width:46px; text-align:center; font-variant-numeric:tabular-nums; color:var(--text, #e7e9ee); }
    .screen .bar button.paste-btn { padding:4px 9px; font-size:12px; }
    .screen iframe { transform:none !important; will-change:auto !important; }
    .solo.fit-contain .screen { justify-content:flex-start !important; }
  \`;
  document.head.appendChild(style);

  // Per-screen state: { zoom, panX, panY }
  const stateByScreen = new Map();
  const ZOOM_STEPS = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5];
  let lastPasteAt = 0;
  let lastSyncedText = '';

  const getState = (name) => {
    let s = stateByScreen.get(name);
    if (!s) {
      s = { zoom: 1, panX: 0, panY: 0 };
      stateByScreen.set(name, s);
    }
    return s;
  };

  const getRfb = (iframe) => {
    try { return iframe?.contentWindow?.UI?.rfb ?? null; } catch { return null; }
  };

  const getCanvas = (iframe) => {
    try {
      return iframe?.contentDocument?.getElementById('noVNC_canvas')
        || iframe?.contentDocument?.querySelector('canvas')
        || null;
    } catch {
      return null;
    }
  };

  const screenNameOf = (screenEl) => {
    if (!screenEl) return '';
    if (screenEl.dataset.screen) return screenEl.dataset.screen;
    const takeBtn = screenEl.querySelector('button[data-take]');
    const name = takeBtn?.dataset?.take || screenEl.querySelector('.bar b')?.textContent?.trim() || '';
    if (name) screenEl.dataset.screen = name;
    return name;
  };

  const isTakeoverActive = (screenEl) => {
    return screenEl?.classList.contains('mine') || false;
  };

  function computeCanvasMetrics(iframe, zoom) {
    const cw = iframe?.clientWidth || 640;
    const ch = iframe?.clientHeight || 400;
    const baseScale = Math.min(cw / 1440, ch / 900);
    const effectiveScale = baseScale * zoom;
    const scaledW = Math.max(1, Math.round(1440 * effectiveScale));
    const scaledH = Math.max(1, Math.round(900 * effectiveScale));
    return { cw, ch, baseScale, effectiveScale, scaledW, scaledH };
  }

  function applyCanvasZoomAndPan(screenEl) {
    if (!screenEl) return;
    const name = screenNameOf(screenEl);
    const iframe = screenEl.querySelector('iframe');
    if (!iframe) return;

    iframe.style.transform = 'none';
    iframe.style.willChange = 'auto';

    const st = getState(name);
    if (st.zoom <= 1.005) {
      st.zoom = 1;
      st.panX = 0;
      st.panY = 0;
    }

    const pctBtn = screenEl.querySelector('.zoom-pct');
    if (pctBtn) pctBtn.textContent = Math.round(st.zoom * 100) + '%';

    const canvas = getCanvas(iframe);
    const rfb = getRfb(iframe);
    if (!canvas) return;

    const { cw, ch, scaledW, scaledH } = computeCanvasMetrics(iframe, st.zoom);
    const maxPanX = Math.max(0, scaledW - cw);
    const maxPanY = Math.max(0, scaledH - ch);
    st.panX = Math.max(0, Math.min(maxPanX, st.panX));
    st.panY = Math.max(0, Math.min(maxPanY, st.panY));

    const left = scaledW <= cw ? Math.round((cw - scaledW) / 2) : -Math.round(st.panX);
    const top = scaledH <= ch ? Math.round((ch - scaledH) / 2) : -Math.round(st.panY);

    canvas.style.position = 'absolute';
    canvas.style.left = left + 'px';
    canvas.style.top = top + 'px';
    canvas.style.width = scaledW + 'px';
    canvas.style.height = scaledH + 'px';
    canvas.style.margin = '0';
    canvas.style.transform = 'none';

    if (rfb && rfb._display) {
      const fbW = rfb._display._fb_width || 1440;
      rfb._display._scale = scaledW / fbW;
    }
  }

  function zoomScreenAt(screenEl, nextZoom, iframeX, iframeY) {
    if (!screenEl) return;
    const name = screenNameOf(screenEl);
    const iframe = screenEl.querySelector('iframe');
    if (!iframe) return;

    const st = getState(name);
    const { cw, ch, scaledW: curW, scaledH: curH } = computeCanvasMetrics(iframe, st.zoom);
    const curLeft = curW <= cw ? (cw - curW) / 2 : -st.panX;
    const curTop = curH <= ch ? (ch - curH) / 2 : -st.panY;

    const ix = Number.isFinite(iframeX) ? iframeX : cw / 2;
    const iy = Number.isFinite(iframeY) ? iframeY : ch / 2;

    const u = curW > 0 ? Math.max(0, Math.min(1, (ix - curLeft) / curW)) : 0.5;
    const v = curH > 0 ? Math.max(0, Math.min(1, (iy - curTop) / curH)) : 0.5;

    const clamped = nextZoom < 1.01 ? 1 : Math.min(5, Math.max(1, nextZoom));
    st.zoom = clamped;

    const { scaledW: newW, scaledH: newH } = computeCanvasMetrics(iframe, clamped);
    st.panX = u * newW - ix;
    st.panY = v * newH - iy;
    applyCanvasZoomAndPan(screenEl);
  }

  function stepZoom(screenEl, dir) {
    if (!screenEl) return;
    const name = screenNameOf(screenEl);
    const st = getState(name);
    const next = dir > 0
      ? (ZOOM_STEPS.find((s) => s > st.zoom * 1.01) ?? 5)
      : ([...ZOOM_STEPS].reverse().find((s) => s < st.zoom * 0.99) ?? 1);
    zoomScreenAt(screenEl, next);
  }

  function setScreenTakeover(screenEl, active) {
    if (!screenEl) return;
    screenEl.classList.toggle('mine', active);
    const takeBtn = screenEl.querySelector('button[data-take]');
    if (takeBtn) takeBtn.textContent = active ? 'Give back' : 'Take over';
    const iframe = screenEl.querySelector('iframe');
    const rfb = getRfb(iframe);
    if (rfb) {
      rfb.viewOnly = !active;
      applyCanvasZoomAndPan(screenEl);
      if (active) {
        try { iframe?.focus(); rfb.focus(); } catch {}
      }
    } else if (iframe && iframe.src) {
      const nextSrc = iframe.src.replace(/view_only=[01]/, 'view_only=' + (active ? '0' : '1'));
      if (nextSrc !== iframe.src) iframe.src = nextSrc;
    }
  }

  async function sendClipboardToScreen(name, text, shouldPaste) {
    if (!name || typeof text !== 'string') return;
    const screenEl = Array.from(document.querySelectorAll('.screen')).find((el) => screenNameOf(el) === name);
    if (shouldPaste && screenEl && !isTakeoverActive(screenEl)) {
      setScreenTakeover(screenEl, true);
    }
    const iframe = screenEl?.querySelector('iframe');
    const rfb = getRfb(iframe);
    if (rfb && typeof rfb.clipboardPasteFrom === 'function') {
      try { rfb.clipboardPasteFrom(text); } catch {}
    }

    try {
      console.info('${COMPUTER_CLIPBOARD_CONSOLE_PREFIX}' + JSON.stringify({
        action: shouldPaste ? 'paste' : 'sync',
        screen: name,
        text,
      }));
    } catch {}

    if (shouldPaste && screenEl) {
      const btn = screenEl.querySelector('button[data-paste]');
      if (btn) {
        const prev = btn.textContent;
        btn.textContent = 'Pasted ✓';
        setTimeout(() => { btn.textContent = prev || 'Paste'; }, 1100);
      }
      try { iframe?.focus(); rfb?.focus?.(); } catch {}
    }
  }

  async function pasteFromHostClipboard(name) {
    const now = Date.now();
    if (now - lastPasteAt < 150) return;
    lastPasteAt = now;
    let text = '';
    try {
      if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
        text = await navigator.clipboard.readText();
      }
    } catch {}
    if (text) {
      lastSyncedText = text;
      await sendClipboardToScreen(name, text, true);
    } else {
      try {
        console.info('${COMPUTER_CLIPBOARD_CONSOLE_PREFIX}' + JSON.stringify({
          action: 'paste-from-host',
          screen: name,
        }));
      } catch {}
    }
  }

  async function syncHostClipboardQuietly(name) {
    const screenEl = Array.from(document.querySelectorAll('.screen')).find((el) => screenNameOf(el) === name);
    if (!name || !screenEl || !isTakeoverActive(screenEl)) return;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
        const text = await navigator.clipboard.readText();
        if (text && text !== lastSyncedText) {
          lastSyncedText = text;
          await sendClipboardToScreen(name, text, false);
        }
      }
    } catch {}
  }

  function sendCtrlChordToRfb(rfb, keysym, code, withShift = false) {
    if (!rfb || typeof rfb.sendKey !== 'function') return;
    try {
      rfb.sendKey(0xffeb, 'MetaLeft', false);
      rfb.sendKey(0xffec, 'MetaRight', false);
      rfb.sendKey(0xffe3, 'ControlLeft', true);
      if (withShift) rfb.sendKey(0xffe1, 'ShiftLeft', true);
      rfb.sendKey(keysym, code, true);
      rfb.sendKey(keysym, code, false);
      if (withShift) rfb.sendKey(0xffe1, 'ShiftLeft', false);
      rfb.sendKey(0xffe3, 'ControlLeft', false);
    } catch {}
  }

  function upgradeScreenElement(screenEl) {
    if (!screenEl) return;
    const name = screenNameOf(screenEl);
    if (!name) return;

    const bar = screenEl.querySelector('.bar');
    const takeBtn = bar?.querySelector('button[data-take]');
    if (bar && takeBtn && !bar.querySelector('.zoom-group')) {
      const zoomGroup = document.createElement('span');
      zoomGroup.className = 'zoom-group';
      zoomGroup.setAttribute('role', 'group');
      zoomGroup.setAttribute('aria-label', 'Zoom controls');
      zoomGroup.innerHTML = \`
        <button type="button" data-zoom-out="\${name}" title="Zoom out (⌘-)" aria-label="Zoom out">−</button>
        <button type="button" data-zoom-reset="\${name}" class="zoom-pct" title="Reset zoom to fit (⌘0)">100%</button>
        <button type="button" data-zoom-in="\${name}" title="Zoom in (⌘+)" aria-label="Zoom in">+</button>
      \`;
      const pasteBtn = document.createElement('button');
      pasteBtn.type = 'button';
      pasteBtn.className = 'paste-btn';
      pasteBtn.dataset.paste = name;
      pasteBtn.title = \`Paste clipboard into \${name} (⌘V)\`;
      pasteBtn.textContent = 'Paste';
      bar.insertBefore(zoomGroup, takeBtn);
      bar.insertBefore(pasteBtn, takeBtn);
    }

    const iframe = screenEl.querySelector('iframe');
    if (!iframe) return;

    if (screenEl.__ocBoundV4) return;
    screenEl.__ocBoundV4 = true;

    let gestureBase = null;
    const resolveIframePoint = (e) => {
      if (e.view && e.view !== window) {
        return { ix: e.clientX || 0, iy: e.clientY || 0 };
      }
      const rect = iframe.getBoundingClientRect();
      return {
        ix: (e.clientX || 0) - rect.left,
        iy: (e.clientY || 0) - rect.top,
      };
    };

    const onWheel = (e) => {
      const st = getState(name);
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const { ix, iy } = resolveIframePoint(e);
        const pixels = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        const capped = Math.max(-30, Math.min(30, pixels));
        const factor = Math.exp(-capped / 100);
        zoomScreenAt(screenEl, st.zoom * factor, ix, iy);
        return;
      }
      if (st.zoom > 1.005 && e.altKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const dx = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        st.panX += dx;
        st.panY += dy;
        applyCanvasZoomAndPan(screenEl);
      }
    };

    const onGestureStart = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      gestureBase = getState(name).zoom;
    };
    const onGestureChange = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (gestureBase === null) return;
      const { ix, iy } = resolveIframePoint(e);
      zoomScreenAt(screenEl, gestureBase * (e.scale || 1), ix, iy);
    };
    const onGestureEnd = (e) => {
      e.preventDefault();
      gestureBase = null;
    };

    const onPaste = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t.id !== 'noVNC_keyboardinput') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const now = Date.now();
      if (now - lastPasteAt < 150) return;
      lastPasteAt = now;
      const text = e.clipboardData?.getData('text/plain') || '';
      if (text) {
        lastSyncedText = text;
        void sendClipboardToScreen(name, text, true);
      } else {
        void pasteFromHostClipboard(name);
      }
    };

    const onCopyOrCut = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t.id !== 'noVNC_keyboardinput') return;
      if (!isTakeoverActive(screenEl)) return;
      const sel = window.getSelection?.()?.toString() || '';
      if (sel) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const rfb = getRfb(iframe);
      const isCut = e.type === 'cut';
      sendCtrlChordToRfb(rfb, isCut ? 0x0078 : 0x0063, isCut ? 'KeyX' : 'KeyC');
    };

    const onKeyDown = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t.id !== 'noVNC_keyboardinput') return;

      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        if (e.key === '=' || e.key === '+') { e.preventDefault(); e.stopImmediatePropagation(); stepZoom(screenEl, 1); return; }
        if (e.key === '-') { e.preventDefault(); e.stopImmediatePropagation(); stepZoom(screenEl, -1); return; }
        if (e.key === '0') { e.preventDefault(); e.stopImmediatePropagation(); zoomScreenAt(screenEl, 1); return; }
      }

      if (!isTakeoverActive(screenEl)) return;
      const rfb = getRfb(iframe);

      if (e.key === 'Meta') {
        e.stopImmediatePropagation();
        return;
      }

      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        const k = (e.key || '').toLowerCase();
        if (k === 'v' && !e.shiftKey) {
          e.preventDefault();
          e.stopImmediatePropagation();
          void pasteFromHostClipboard(name);
          return;
        }
        if (e.metaKey && k === 'c' && !e.shiftKey) {
          e.preventDefault();
          e.stopImmediatePropagation();
          sendCtrlChordToRfb(rfb, 0x0063, 'KeyC');
          return;
        }
        if (e.metaKey && k === 'x' && !e.shiftKey) {
          e.preventDefault();
          e.stopImmediatePropagation();
          sendCtrlChordToRfb(rfb, 0x0078, 'KeyX');
          return;
        }
        if (e.metaKey && k === 'a' && !e.shiftKey) {
          e.preventDefault();
          e.stopImmediatePropagation();
          sendCtrlChordToRfb(rfb, 0x0061, 'KeyA');
          return;
        }
        if (e.metaKey && k === 'z') {
          e.preventDefault();
          e.stopImmediatePropagation();
          sendCtrlChordToRfb(rfb, 0x007a, 'KeyZ', e.shiftKey);
          return;
        }
      }
    };

    screenEl.addEventListener('wheel', onWheel, { capture: true, passive: false });
    screenEl.addEventListener('gesturestart', onGestureStart, { capture: true });
    screenEl.addEventListener('gesturechange', onGestureChange, { capture: true });
    screenEl.addEventListener('gestureend', onGestureEnd, { capture: true });
    screenEl.addEventListener('mouseenter', () => { void syncHostClipboardQuietly(name); });

    const attachToIframeWindow = () => {
      try {
        const cw = iframe.contentWindow;
        const cd = iframe.contentDocument;
        if (!cw) return;
        suppressResizeObserverError(cw);
        if (cd && !cd.getElementById('oc-novnc-clean-v4')) {
          const oldStyle = cd.getElementById('oc-novnc-clean');
          if (oldStyle) oldStyle.remove();
          const s = cd.createElement('style');
          s.id = 'oc-novnc-clean-v4';
          s.textContent = \`
            html, body, #noVNC_container, #noVNC_screen {
              overflow: hidden !important;
              background: #000 !important;
              position: relative !important;
              width: 100% !important;
              height: 100% !important;
              margin: 0 !important;
            }
            #noVNC_container { border-radius: 0 !important; clip-path: none !important; }
          #noVNC_container canvas {
              box-shadow: none !important;
              border-radius: 0 !important;
              transform: none !important;
            }
            #noVNC_control_bar_anchor {
              display: none !important;
              visibility: hidden !important;
              pointer-events: none !important;
            }
          \`;
          cd.head?.appendChild(s);
        }
        if (cw.__ocBoundV4) return;
        cw.__ocBoundV4 = true;
        cw.addEventListener('wheel', onWheel, { capture: true, passive: false });
        cw.addEventListener('gesturestart', onGestureStart, { capture: true });
        cw.addEventListener('gesturechange', onGestureChange, { capture: true });
        cw.addEventListener('gestureend', onGestureEnd, { capture: true });
        cw.addEventListener('paste', onPaste, { capture: true });
        cw.addEventListener('copy', onCopyOrCut, { capture: true });
        cw.addEventListener('cut', onCopyOrCut, { capture: true });
        cw.addEventListener('keydown', onKeyDown, { capture: true });
        cw.addEventListener('focus', () => { void syncHostClipboardQuietly(name); });
        cw.addEventListener('resize', () => {
          requestAnimationFrame(() => applyCanvasZoomAndPan(screenEl));
        });
      } catch {}
    };

    const attachRfbListeners = () => {
      const rfb = getRfb(iframe);
      if (!rfb) return;
      const wantViewOnly = !isTakeoverActive(screenEl);
      if (rfb.viewOnly !== wantViewOnly) rfb.viewOnly = wantViewOnly;
      if (rfb._display && !rfb._display.__ocAutoscalePatched) {
        rfb._display.__ocAutoscalePatched = true;
        const origAutoscale = rfb._display.autoscale?.bind(rfb._display);
        if (origAutoscale) {
          rfb._display.autoscale = (...args) => {
            const res = origAutoscale(...args);
            applyCanvasZoomAndPan(screenEl);
            return res;
          };
        }
      }
      if (!rfb.__ocClipboardBound) {
        rfb.__ocClipboardBound = true;
        rfb.addEventListener('clipboard', (e) => {
          const copied = e?.detail?.text;
          if (typeof copied === 'string' && copied) {
            lastSyncedText = copied;
            try {
              console.info('${COMPUTER_CLIPBOARD_CONSOLE_PREFIX}' + JSON.stringify({
                action: 'copy',
                screen: name,
                text: copied,
              }));
            } catch {}
          }
        });
      }
    };

    iframe.addEventListener('load', () => {
      attachToIframeWindow();
      attachRfbListeners();
      applyCanvasZoomAndPan(screenEl);
      setTimeout(() => { attachToIframeWindow(); attachRfbListeners(); applyCanvasZoomAndPan(screenEl); }, 250);
    });

    attachToIframeWindow();
    attachRfbListeners();
    applyCanvasZoomAndPan(screenEl);
  }

  // Prevent legacy ui.html refresh() from tearing down #grid iframes when takeover or recording state changes
  const grid = document.getElementById('grid');
  if (grid && !grid.__ocInnerHtmlGuarded) {
    grid.__ocInnerHtmlGuarded = true;
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    if (desc && desc.set && desc.get) {
      Object.defineProperty(grid, 'innerHTML', {
        configurable: true,
        get() { return desc.get.call(this); },
        set(html) {
          try {
            const temp = document.createElement('div');
            desc.set.call(temp, html);
            const incoming = Array.from(temp.querySelectorAll('.screen'));
            const current = Array.from(this.querySelectorAll('.screen'));
            const incomingNames = incoming.map((el) => screenNameOf(el)).filter(Boolean);
            const currentNames = current.map((el) => screenNameOf(el)).filter(Boolean);
            if (incomingNames.length > 0 && incomingNames.join(',') === currentNames.join(',')) {
              incoming.forEach((inc, idx) => {
                const cur = current[idx];
                const incDot = inc.querySelector('.dot');
                const curDot = cur?.querySelector('.dot');
                if (curDot && incDot) curDot.classList.toggle('rec', incDot.classList.contains('rec'));
                if (inc.classList.contains('mine') && !isTakeoverActive(cur)) {
                  setScreenTakeover(cur, true);
                }
              });
              return;
            }
          } catch {}
          desc.set.call(this, html);
          scanAll();
        },
      });
    }
  }

  document.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('button');
    if (!btn) return;
    if (btn.dataset.zoomIn) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const el = Array.from(document.querySelectorAll('.screen')).find((s) => screenNameOf(s) === btn.dataset.zoomIn);
      stepZoom(el, 1);
      return;
    }
    if (btn.dataset.zoomOut) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const el = Array.from(document.querySelectorAll('.screen')).find((s) => screenNameOf(s) === btn.dataset.zoomOut);
      stepZoom(el, -1);
      return;
    }
    if (btn.dataset.zoomReset) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const el = Array.from(document.querySelectorAll('.screen')).find((s) => screenNameOf(s) === btn.dataset.zoomReset);
      zoomScreenAt(el, 1);
      return;
    }
    if (btn.dataset.paste) {
      e.preventDefault();
      e.stopImmediatePropagation();
      void pasteFromHostClipboard(btn.dataset.paste);
      return;
    }
    if (btn.dataset.take) {
      const el = btn.closest('.screen');
      if (el) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const nextActive = !isTakeoverActive(el);
        setScreenTakeover(el, nextActive);
        if (nextActive) void syncHostClipboardQuietly(screenNameOf(el));
      }
    }
  }, true);

  window.addEventListener('paste', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const screenEl = document.querySelector('.screen.mine') || document.querySelector('.screen');
    const name = screenNameOf(screenEl);
    if (!name) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastPasteAt < 150) return;
    lastPasteAt = now;
    const text = e.clipboardData?.getData('text/plain') || '';
    if (text) {
      lastSyncedText = text;
      void sendClipboardToScreen(name, text, true);
    } else {
      void pasteFromHostClipboard(name);
    }
  }, true);

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const screenEl = document.querySelector('.screen.mine') || document.querySelector('.screen');
    const name = screenNameOf(screenEl);
    if ((e.metaKey || e.ctrlKey) && !e.altKey && screenEl) {
      if (e.key === '=' || e.key === '+') { e.preventDefault(); stepZoom(screenEl, 1); return; }
      if (e.key === '-') { e.preventDefault(); stepZoom(screenEl, -1); return; }
      if (e.key === '0') { e.preventDefault(); zoomScreenAt(screenEl, 1); return; }
      if ((e.key || '').toLowerCase() === 'v' && !e.shiftKey && name) {
        e.preventDefault();
        void pasteFromHostClipboard(name);
      }
    }
  }, true);

  window.__ocComputerPasteText = (text, screenName) => {
    const screenEl = document.querySelector('.screen.mine') || document.querySelector('.screen');
    const target = screenName || screenNameOf(screenEl);
    if (target && typeof text === 'string' && text) {
      lastSyncedText = text;
      void sendClipboardToScreen(target, text, true);
    }
  };

  window.__ocComputerZoomAction = (action) => {
    const screenEl = document.querySelector('.screen.mine') || document.querySelector('.screen');
    if (!screenEl) return;
    if (action === 'zoom-in') stepZoom(screenEl, 1);
    else if (action === 'zoom-out') stepZoom(screenEl, -1);
    else if (action === 'zoom-reset') zoomScreenAt(screenEl, 1);
  };

  const scanAll = () => {
    document.querySelectorAll('.screen').forEach((el) => {
      upgradeScreenElement(el);
      const iframe = el.querySelector('iframe');
      if (iframe?.contentWindow && !iframe.contentWindow.__ocBoundV4) {
        el.__ocBoundV4 = false;
        upgradeScreenElement(el);
      }
      applyCanvasZoomAndPan(el);
    });
  };

  const observeTarget = grid || document.body;
  if (typeof MutationObserver !== 'undefined' && observeTarget) {
    const mo = new MutationObserver(() => scanAll());
    mo.observe(observeTarget, { childList: true, subtree: true });
  }
  scanAll();
  setInterval(scanAll, 600);
  return true;
})();`;

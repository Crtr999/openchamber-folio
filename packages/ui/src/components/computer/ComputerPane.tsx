import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { copyTextToClipboard } from '@/lib/clipboard';
import { isDesktopLocalOriginActive } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useUIStore } from '@/stores/useUIStore';
import {
  COMPUTER_VIEW_ENHANCEMENT_SCRIPT,
  parseComputerClipboardConsoleMessage,
} from './computerViewBridge';

/**
 * The agent's computer, inside the app.
 *
 * The computer belongs to a tool, and the tool's control centre is a web page
 * that shows the screen live. So the computer is shown here the way every other
 * page is shown: embedded, resizable with the panel, and expandable to the
 * full window.
 *
 * The control centre needs the tool's key. The Electron main sets it as a
 * cookie on this window's own session, so the page authenticates itself and
 * the key never reaches the renderer.
 */

type ComputerState = {
  available: boolean;
  baseUrl: string | null;
  screens: Array<{ name: string; since: string }>;
};

const readComputerState = async (signal?: AbortSignal): Promise<ComputerState> => {
  try {
    const response = await runtimeFetch('/api/computer/state', { cache: 'no-store', signal });
    if (!response.ok) return { available: false, baseUrl: null, screens: [] };
    const payload = await response.json() as Partial<ComputerState> | null;
    return {
      available: payload?.available === true,
      baseUrl: typeof payload?.baseUrl === 'string' ? payload.baseUrl : null,
      screens: Array.isArray(payload?.screens) ? payload.screens : [],
    };
  } catch {
    return { available: false, baseUrl: null, screens: [] };
  }
};

const sendClipboardToComputer = async (screen: string, text: string, paste: boolean): Promise<boolean> => {
  if (!screen || typeof text !== 'string') return false;
  try {
    const response = await runtimeFetch('/api/computer/clipboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screen, text, paste }),
    });
    return response.ok;
  } catch {
    return false;
  }
};

export function ComputerPane({ directory, requestedScreen }: { directory: string | null; requestedScreen?: string | null }) {
  const { t } = useI18n();
  const [state, setState] = React.useState<ComputerState | null>(null);
  const [selected, setSelected] = React.useState<string | null>(requestedScreen ?? null);
  const [webviewElement, setWebviewElement] = React.useState<WebviewElement | null>(null);
  const webviewRef = React.useRef<WebviewElement | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const openContextBrowser = useUIStore((state) => state.openContextBrowser);

  const attachWebview = React.useCallback((node: WebviewElement | null) => {
    webviewRef.current = node;
    setWebviewElement(node);
  }, []);

  React.useEffect(() => {
    if (requestedScreen) setSelected(requestedScreen);
  }, [requestedScreen]);

  const refresh = React.useCallback(async (signal?: AbortSignal) => {
    const next = await readComputerState(signal);
    setState(next);
    setSelected((current) => {
      if (current && next.screens.some((screen) => screen.name === current)) return current;
      return next.screens[0]?.name ?? null;
    });
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    // The computer changes while the app is open, so the list is read again
    // when the user comes back to it, and while they are watching it: a screen
    // a bot opens has to appear on its own, not on the next click.
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(onVisible, 2000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  // Inject pinch-to-zoom and clipboard bridge into the embedded control centre
  // and handle clipboard sync / paste messages from the guest page.
  React.useEffect(() => {
    if (!webviewElement) return;

    const injectEnhancements = () => {
      try {
        void webviewElement.executeJavaScript(COMPUTER_VIEW_ENHANCEMENT_SCRIPT, false).catch(() => {});
      } catch {
        // Not attached yet.
      }
    };

    const onConsoleMessage = (event: Event) => {
      const detail = event as unknown as { message?: string };
      const message = typeof detail.message === 'string' ? detail.message : '';
      const payload = parseComputerClipboardConsoleMessage(message);
      if (!payload) return;

      if (payload.action === 'copy' && payload.text) {
        void copyTextToClipboard(payload.text);
        return;
      }

      if (payload.action === 'paste' || payload.action === 'sync') {
        if (typeof payload.text === 'string' && payload.text.length > 0) {
          void sendClipboardToComputer(payload.screen, payload.text, payload.action === 'paste');
        }
        return;
      }

      if (payload.action === 'paste-from-host') {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
          void navigator.clipboard.readText()
            .then((text) => {
              if (text) void sendClipboardToComputer(payload.screen, text, true);
            })
            .catch(() => {});
        }
      }
    };

    webviewElement.addEventListener('dom-ready', injectEnhancements);
    webviewElement.addEventListener('did-finish-load', injectEnhancements);
    webviewElement.addEventListener('console-message', onConsoleMessage);
    return () => {
      webviewElement.removeEventListener('dom-ready', injectEnhancements);
      webviewElement.removeEventListener('did-finish-load', injectEnhancements);
      webviewElement.removeEventListener('console-message', onConsoleMessage);
    };
  }, [webviewElement]);

  // Forward menu zoom commands (Cmd/Ctrl + =, -, 0) and host paste events when
  // focus is inside the Computer pane.
  React.useEffect(() => {
    const handleZoom = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const webview = webviewRef.current;
      if (!webview) return;
      const active = document.activeElement;
      if (active !== webview && !containerRef.current?.contains(active)) return;
      const action = event.detail;
      if (action === 'zoom-in' || action === 'zoom-out' || action === 'zoom-reset') {
        try {
          void webview.executeJavaScript(`window.__ocComputerZoomAction?.(${JSON.stringify(action)})`, true).catch(() => {});
        } catch {
          // ignore
        }
      }
    };

    const handlePaste = (event: ClipboardEvent) => {
      const webview = webviewRef.current;
      if (!webview || !selected) return;
      const active = document.activeElement;
      if (!containerRef.current?.contains(active)) return;
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (!text) return;
      event.preventDefault();
      try {
        void webview.executeJavaScript(
          `window.__ocComputerPasteText?.(${JSON.stringify(text)}, ${JSON.stringify(selected)})`,
          true,
        ).catch(() => {});
      } catch {
        void sendClipboardToComputer(selected, text, true);
      }
    };

    window.addEventListener('openchamber:zoom', handleZoom);
    window.addEventListener('paste', handlePaste);
    return () => {
      window.removeEventListener('openchamber:zoom', handleZoom);
      window.removeEventListener('paste', handlePaste);
    };
  }, [selected]);

  if (!state) {
    return <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">{t('common.loading')}</div>;
  }

  if (!state.available || !state.baseUrl) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Icon name="window" className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium">{t('computer.unavailable')}</p>
        <p className="max-w-xs text-xs text-muted-foreground">{t('computer.unavailableHint')}</p>
      </div>
    );
  }

  const screen = selected;
  // `fit=contain` keeps the remote frame at its own proportions inside the
  // panel, so dragging the panel does not rescale a stretched image on every
  // frame.
  const embedUrl = screen ? `${state.baseUrl}/?screen=${encodeURIComponent(screen)}&solo=1&fit=contain` : null;

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col">
      {state.screens.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-border/50 px-3 py-2">
          {state.screens.map((item) => (
            <Button
              key={item.name}
              type="button"
              variant="ghost"
              size="xs"
              aria-pressed={item.name === selected}
              className={item.name === selected ? 'bg-interactive-selection text-interactive-selection-foreground' : 'text-muted-foreground'}
              onClick={() => setSelected(item.name)}
            >
              {item.name}
            </Button>
          ))}
        </div>
      )}
      {embedUrl ? (
        isDesktopLocalOriginActive() ? (
          <webview
            ref={attachWebview}
            key={embedUrl}
            src={embedUrl}
            partition="persist:openchamber-browser"
            title={t('computer.title')}
            className="min-h-0 flex-1 border-0 bg-black"
            style={{ width: '100%', height: '100%' }}
          />
        ) : <iframe
          key={embedUrl}
          src={embedUrl}
          title={t('computer.title')}
          className="min-h-0 flex-1 border-0 bg-black"
          allow="clipboard-read; clipboard-write"
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <Icon name="window" className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium">{t('computer.noScreens')}</p>
          <p className="max-w-xs text-xs text-muted-foreground">{t('computer.noScreensHint')}</p>
          {directory && (
            <Button variant="outline" size="sm" onClick={() => openContextBrowser(directory, state.baseUrl ?? '')}>
              {t('computer.openControl')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

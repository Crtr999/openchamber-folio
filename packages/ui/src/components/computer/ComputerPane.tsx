import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useUIStore } from '@/stores/useUIStore';

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

export function ComputerPane({ directory }: { directory: string | null }) {
  const { t } = useI18n();
  const [state, setState] = React.useState<ComputerState | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const openContextBrowser = useUIStore((state) => state.openContextBrowser);

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
    // when the user comes back to it.
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      controller.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

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
  const embedUrl = screen ? `${state.baseUrl}/?screen=${encodeURIComponent(screen)}&solo=1` : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
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
        <iframe
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

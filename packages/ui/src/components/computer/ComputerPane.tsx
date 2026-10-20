import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useUIStore } from '@/stores/useUIStore';

/**
 * The agent's computer, inside the app.
 *
 * The computer belongs to a tool, and the tool's control centre is a web page.
 * So the honest way to show it inside Open Carter is to open that page in the
 * app's own browser panel — the same panel every other page uses, with the
 * key already set as a cookie, so nothing secret is ever in an address bar.
 *
 * This pane is the way in: it lists the screens the computer has open and
 * opens the one the user picks.
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
  const openContextBrowser = useUIStore((state) => state.openContextBrowser);

  const refresh = React.useCallback(async (signal?: AbortSignal) => {
    setState(await readComputerState(signal));
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

  const openScreen = React.useCallback((screenName: string) => {
    if (!state?.baseUrl || !directory) return;
    const url = `${state.baseUrl}/?screen=${encodeURIComponent(screenName)}&solo=1`;
    openContextBrowser(directory, url);
  }, [directory, openContextBrowser, state?.baseUrl]);

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

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <div>
        <h3 className="typography-ui-label font-semibold text-foreground">{t('computer.title')}</h3>
        <p className="text-[11px] text-muted-foreground">{t('computer.hint')}</p>
      </div>
      {state.screens.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('computer.noScreens')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {state.screens.map((screen) => (
            <li key={screen.name}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="oc-home-row flex w-full items-center justify-between text-xs"
                onClick={() => openScreen(screen.name)}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Icon name="window" className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{screen.name}</span>
                </span>
                <Icon name="arrow-right" className="size-3.5 shrink-0 opacity-40" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

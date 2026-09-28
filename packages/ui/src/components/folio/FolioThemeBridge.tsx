import React from 'react';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import { reportFolioTheme, takeSyncedFolioTheme } from '@/lib/desktop';
import { sameThemeChoice, syncedThemeSchema, type SyncedTheme, type ThemeChoice } from '@/lib/folio/theme-sync';

/** How the Electron main process announces a phone theme the sync service has accepted. */
const SYNCED_EVENT = 'folio:theme-synced';

/**
 * Keeps the Mac's sync service in step with the theme this window is showing, and shows the phone's
 * choice when sync brings a newer one. It lives above the notebook surface because the theme belongs
 * to the whole app: a phone that changes it should be followed whether or not Folio is open here.
 */
export function FolioThemeBridge(): null {
  const { themeMode, lightThemeId, darkThemeId, setThemeMode, setLightThemePreference, setDarkThemePreference } = useThemeSystem();
  const choice = React.useMemo<ThemeChoice>(() => ({ mode: themeMode, light: lightThemeId, dark: darkThemeId }), [darkThemeId, lightThemeId, themeMode]);
  const reported = React.useRef<ThemeChoice | null>(null);
  const adopted = React.useRef<SyncedTheme | null>(null);

  const apply = React.useCallback((theme: SyncedTheme) => {
    adopted.current = theme;
    setLightThemePreference(theme.light);
    setDarkThemePreference(theme.dark);
    setThemeMode(theme.mode);
  }, [setDarkThemePreference, setLightThemePreference, setThemeMode]);

  React.useEffect(() => {
    if (reported.current && sameThemeChoice(reported.current, choice)) {
      adopted.current = null;
      return;
    }
    const opened = reported.current === null;
    const fromPhone = adopted.current && sameThemeChoice(adopted.current, choice) ? adopted.current.at : undefined;
    reported.current = choice;
    adopted.current = null;
    // What the window shows when it opens is the Mac's standing theme, which is the oldest thing on
    // record; a change made here is stamped now, and one taken from the phone keeps the phone's stamp.
    void reportFolioTheme(choice, opened ? undefined : fromPhone ?? Date.now()).catch(() => undefined);
  }, [choice]);

  React.useEffect(() => {
    const onSynced = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const parsed = syncedThemeSchema.safeParse(event.detail);
      if (parsed.success) apply(parsed.data);
    };
    window.addEventListener(SYNCED_EVENT, onSynced);
    // A reload can miss the event, so a window that has just opened asks for what sync accepted.
    void takeSyncedFolioTheme().then((theme) => { if (theme) apply(theme); }).catch(() => undefined);
    return () => window.removeEventListener(SYNCED_EVENT, onSynced);
  }, [apply]);

  return null;
}

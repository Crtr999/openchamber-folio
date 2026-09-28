import React from 'react';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import { phoneTakesMacTheme, sameThemeChoice, syncedThemeSchema, type SyncedTheme, type ThemeChoice } from '@/lib/folio/theme-sync';

/**
 * The iPhone's side of the Folio theme sync: the choice this phone last made, with the moment it was
 * made. The live theme stays where the rest of the app keeps it, in the theme system; this record is
 * what sync sends to the Mac and what the Mac's copy is compared against, so a theme picked here
 * while the Mac is out of reach is still newer than the Mac's when the phone reconnects.
 */
const RECORD = 'folio.theme';

/** How sync hands the Mac's accepted theme to the app, the way focus and settings reach it. */
const SYNCED_EVENT = 'folio:theme-synced';

/** The phone's last theme choice, with when it was made. Absent until a theme is chosen here. */
export const readFolioTheme = (): SyncedTheme | undefined => {
  try {
    const raw = localStorage.getItem(RECORD);
    if (!raw) return undefined;
    const parsed = syncedThemeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

const writeFolioTheme = (theme: SyncedTheme): void => {
  try { localStorage.setItem(RECORD, JSON.stringify(theme)); } catch { /* storage blocked; the Mac's copy still reaches the app */ }
};

/** A fresh pairing starts from the Mac's theme, so the phone offers its choice again from then on. */
export const clearFolioTheme = (): void => {
  try { localStorage.removeItem(RECORD); } catch { /* storage blocked */ }
};

/**
 * The theme the app should show for a Mac choice, or undefined when the Mac's is the older one and
 * the phone keeps what it has. The record is written before the app is told, so applying the Mac's
 * choice is not mistaken for a change made here and stamped a second time.
 */
export const takeMacTheme = (incoming: SyncedTheme | null | undefined): SyncedTheme | undefined => {
  if (!incoming || !phoneTakesMacTheme(readFolioTheme(), incoming)) return undefined;
  writeFolioTheme(incoming);
  return incoming;
};

/** Announces the Mac's choice to the app, once sync has decided it is the newer one. */
export const announceMacTheme = (theme: SyncedTheme): void => {
  window.dispatchEvent(new CustomEvent(SYNCED_EVENT, { detail: theme }));
};

/**
 * Keeps the phone's theme record in step with what the app is showing, and applies the Mac's choice
 * when sync brings one. Only a change made while the app runs is stamped: what the app opened with is
 * the Mac's value until the user picks something here, and stamping it on launch would make a phone
 * that has just started look like the newest change on either device.
 */
export const useFolioThemeSync = (): void => {
  const { themeMode, lightThemeId, darkThemeId, setThemeMode, setLightThemePreference, setDarkThemePreference } = useThemeSystem();
  const choice = React.useMemo<ThemeChoice>(() => ({ mode: themeMode, light: lightThemeId, dark: darkThemeId }), [darkThemeId, lightThemeId, themeMode]);
  const opened = React.useRef(false);

  React.useEffect(() => {
    const record = readFolioTheme();
    if (record && sameThemeChoice(record, choice)) return;
    if (opened.current) writeFolioTheme({ ...choice, at: Date.now() });
    opened.current = true;
  }, [choice]);

  React.useEffect(() => {
    const onSynced = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const parsed = syncedThemeSchema.safeParse(event.detail);
      if (!parsed.success) return;
      setLightThemePreference(parsed.data.light);
      setDarkThemePreference(parsed.data.dark);
      setThemeMode(parsed.data.mode);
    };
    window.addEventListener(SYNCED_EVENT, onSynced);
    return () => window.removeEventListener(SYNCED_EVENT, onSynced);
  }, [setDarkThemePreference, setLightThemePreference, setThemeMode]);
};

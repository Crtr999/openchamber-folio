import { describe, expect, test } from 'bun:test';

import { phoneTakesMacTheme, sameThemeChoice, syncedThemeSchema, type SyncedTheme } from './theme-sync';

const dracula: SyncedTheme = { mode: 'dark', light: 'openchamber-light', dark: 'dracula-dark', at: 1_000 };
const nord: SyncedTheme = { mode: 'light', light: 'nord-light', dark: 'nord-dark', at: 2_000 };

describe('the Folio theme choice', () => {
  test('a phone with no choice of its own takes the Mac theme, and a tie stays with the Mac', () => {
    // Nothing chosen here yet, so whatever the Mac is showing wins — the case a fresh pairing is in.
    expect(phoneTakesMacTheme(undefined, { ...dracula, at: 0 })).toBe(true);
    // The Mac's own value coming back is the same change, not a newer one.
    expect(phoneTakesMacTheme({ ...nord, at: 1_000 }, { ...dracula, at: 1_000 })).toBe(true);
    // A choice the user made on the phone after the Mac's is the newer change and stands.
    expect(phoneTakesMacTheme({ ...nord, at: 2_000 }, { ...dracula, at: 1_000 })).toBe(false);
    expect(phoneTakesMacTheme({ ...nord, at: 1_000 }, { ...dracula, at: 2_000 })).toBe(true);
  });

  test('the wire form is the choice plus the moment it changed', () => {
    expect(syncedThemeSchema.safeParse(dracula).success).toBe(true);
    expect(syncedThemeSchema.safeParse({ mode: 'system', light: 'a-light', dark: 'a-dark', at: 0 }).success).toBe(true);
    expect(syncedThemeSchema.safeParse({ mode: 'sepia', light: 'a-light', dark: 'a-dark', at: 1 }).success).toBe(false);
    expect(syncedThemeSchema.safeParse({ mode: 'dark', light: '', dark: 'a-dark', at: 1 }).success).toBe(false);
    expect(syncedThemeSchema.safeParse({ mode: 'dark', light: 'a-light', dark: 'a-dark' }).success).toBe(false);
    expect(syncedThemeSchema.safeParse({ mode: 'dark', light: 'a-light', dark: 'a-dark', at: -1 }).success).toBe(false);
    expect(syncedThemeSchema.safeParse({ mode: 'dark', light: 'a-light', dark: 'a-dark', at: 1.5 }).success).toBe(false);
  });

  test('two choices are the same only when the mode and both presets are', () => {
    const sameChoiceLater: SyncedTheme = { ...dracula, at: 9_000 };
    const systemMode: SyncedTheme = { ...dracula, mode: 'system' };
    expect(sameThemeChoice(dracula, nord)).toBe(false);
    expect(sameThemeChoice(dracula, sameChoiceLater)).toBe(true);
    expect(sameThemeChoice(dracula, systemMode)).toBe(false);
  });
});

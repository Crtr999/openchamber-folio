import { z } from 'zod';

/**
 * The theme choice that travels between the Mac and the iPhone over Folio sync: which preset each
 * variant uses and whether the system decides, with the moment the user last changed it. Colours are
 * never synced, only the choice, so each device resolves the theme from its own copy of the presets
 * and a preset added later cannot leave the other device showing stale colours.
 *
 * `packages/electron/folio-sync.mjs` owns the protocol; this is the client half of the same contract,
 * the way `sync.ts` mirrors that module's `chatHash`.
 */
export const syncedThemeSchema = z.object({
  mode: z.enum(['light', 'dark', 'system']),
  light: z.string().min(1).max(120),
  dark: z.string().min(1).max(120),
  at: z.number().int().nonnegative(),
});
export type SyncedTheme = z.infer<typeof syncedThemeSchema>;

/** The same three values without a stamp: what a device shows when it has not changed anything itself. */
export type ThemeChoice = Omit<SyncedTheme, 'at'>;

export const sameThemeChoice = (left: ThemeChoice, right: ThemeChoice): boolean =>
  left.mode === right.mode && left.light === right.light && left.dark === right.dark;

/**
 * The iPhone shows the Mac's choice when the Mac's is the same change or a newer one, so a phone
 * that has never chosen a theme picks up whatever the Mac is using, and one that has keeps it until
 * the Mac's own choice moves past it. A tie belongs to the Mac, which is the device the notebook and
 * the settings live on; the Mac reads the same comparison the other way round, and takes the phone's
 * choice only for a strictly newer change, so a tie never restamps the value and starts a swap.
 */
export const phoneTakesMacTheme = (local: SyncedTheme | undefined, incoming: SyncedTheme): boolean =>
  incoming.at >= (local?.at ?? 0);

import { z } from 'zod';
import { invokeDesktop, isDesktopLocalOriginActive, isElectronShell } from '@/lib/desktop';

/** Texting needs the desktop app: it owns Messages.app and the local server. */
export const imessageSupported = () => isElectronShell() && isDesktopLocalOriginActive();

const accessSchema = z.enum(['unknown', 'granted', 'denied', 'error', 'no-account']);

const friendSchema = z.object({
  key: z.string(),
  label: z.string(),
  zdr: z.boolean(),
  handles: z.array(z.string()),
});

const statusSchema = z.object({
  enabled: z.boolean(),
  handles: z.array(z.string()),
  defaultFriend: z.string().nullable(),
  forwardNotifications: z.boolean(),
  morning: z.object({
    enabled: z.boolean(),
    time: z.string(),
    lastDay: z.string(),
  }),
  readAccess: accessSchema,
  sendAccess: accessSchema,
  running: z.boolean(),
  conversations: z.number().nonnegative(),
  pending: z.number().nonnegative(),
  lastError: z.string().nullable(),
  lastErrorAt: z.number().nullable(),
  lastTextAt: z.number().nullable(),
  lastInboundAt: z.number().nullable(),
  chatDbPath: z.string(),
  friends: z.array(friendSchema).default([]),
  permissionHint: z.string().nullable(),
});

export type ImessageStatus = z.infer<typeof statusSchema>;
export type ImessageFriend = z.infer<typeof friendSchema>;

const invoke = async (args: Record<string, unknown>): Promise<ImessageStatus> => {
  if (!imessageSupported()) throw new Error('Texting is available in the desktop app.');
  return statusSchema.parse(await invokeDesktop('desktop_imessage', args));
};

export const readImessageStatus = () => invoke({ action: 'status' });

export const configureImessage = (patch: {
  enabled?: boolean;
  handles?: string[];
  defaultFriend?: string | null;
  forwardNotifications?: boolean;
  morningEnabled?: boolean;
  morningTime?: string;
}) => invoke({ action: 'configure', ...patch });

/** Send the morning follow-up text now, without waiting for its time. */
export const sendMorningImessage = async () => {
  if (!imessageSupported()) throw new Error('Texting is available in the desktop app.');
  return z.object({ sent: z.boolean(), text: z.string(), handle: z.string() }).parse(
    await invokeDesktop('desktop_imessage', { action: 'morning-test' }),
  );
};

export const testImessage = async (handle?: string) => {
  if (!imessageSupported()) throw new Error('Texting is available in the desktop app.');
  return z.object({ sent: z.boolean(), handle: z.string() }).parse(
    await invokeDesktop('desktop_imessage', { action: 'test', ...(handle ? { handle } : {}) }),
  );
};

/** Forget the sessions one friend holds in every thread, so the next text to
 *  that friend starts a fresh Open Carter chat. */
export const resetImessageFriend = (friend: string) => invoke({ action: 'reset', friend });

/** Notification navigation stays on the app origin and retains the dedicated
 * mobile renderer when an existing installed mobile window is focused. */
export function notificationTarget(raw: string | undefined, origin: string, clientUrl?: string): string {
  const fallback = new URL('/', origin);
  let target: URL;
  try { target = new URL(raw || '/', origin); } catch { return fallback.href; }
  if (target.origin !== fallback.origin) return fallback.href;
  if (clientUrl) {
    try {
      const client = new URL(clientUrl);
      if (client.origin === fallback.origin && client.pathname === '/mobile.html' && target.pathname === '/') {
        target.pathname = '/mobile.html';
      }
    } catch { /* An invalid stale client URL must not prevent opening the app. */ }
  }
  return target.href;
}

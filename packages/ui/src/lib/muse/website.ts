/** The standalone Muse service. Signed-in routes and DOM are not yet verified. */
export const MUSE_URL = 'https://muse.ai/';
export const MUSE_PARTITION = 'persist:open-carter-muse';

/** User-saved page links are exact-origin metadata, not inferred chat IDs. */
export function musePageUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.origin !== new URL(MUSE_URL).origin || url.username || url.password || url.search || url.hash) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Only the current site's public page title is mirrored, never URL parameters. */
export function musePageTitle(url: string, title: string): string {
  try {
    if (new URL(url).origin !== new URL(MUSE_URL).origin) return '';
    return title.trim().slice(0, 200);
  } catch {
    return '';
  }
}

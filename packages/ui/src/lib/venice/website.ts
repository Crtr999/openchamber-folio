/** Official Venice chat entry. Account content stays in the isolated website. */
export const VENICE_URL = 'https://venice.ai/chat/classic';
export const VENICE_PARTITION = 'persist:open-carter-venice';

/** Exact observed page links only, never inferred conversation identifiers. */
export function venicePageUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.origin !== new URL(VENICE_URL).origin || url.username || url.password || url.search || url.hash) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Live page titles are display metadata, never conversation identifiers. */
export function venicePageTitle(url: string, title: string): string {
  try {
    if (new URL(url).origin !== new URL(VENICE_URL).origin) return '';
    return title.trim().slice(0, 200);
  } catch {
    return '';
  }
}

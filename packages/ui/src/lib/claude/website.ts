/** Claude's official website. Signed-in DOM and routes remain unverified. */
export const CLAUDE_URL = 'https://claude.ai/';
export const CLAUDE_PARTITION = 'persist:open-carter-claude';

/** Exact observed page links only, never inferred conversation identifiers. */
export function claudePageUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.origin !== new URL(CLAUDE_URL).origin || url.username || url.password || url.search || url.hash) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Live page titles are display metadata, never conversation identifiers. */
export function claudePageTitle(url: string, title: string): string {
  try {
    if (new URL(url).origin !== new URL(CLAUDE_URL).origin) return '';
    return title.trim().slice(0, 200);
  } catch {
    return '';
  }
}

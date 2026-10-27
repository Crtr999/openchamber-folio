/** Official Gemini chat entry. Account content stays in the isolated website. */
export const GEMINI_URL = 'https://gemini.google.com/app';
export const GEMINI_PARTITION = 'persist:open-carter-gemini';

/** Exact observed page links only, never inferred conversation identifiers. */
export function geminiPageUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.origin !== new URL(GEMINI_URL).origin || url.username || url.password || url.search || url.hash) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Live page titles are display metadata, never conversation identifiers. */
export function geminiPageTitle(url: string, title: string): string {
  try {
    if (new URL(url).origin !== new URL(GEMINI_URL).origin) return '';
    return title.trim().slice(0, 200);
  } catch {
    return '';
  }
}

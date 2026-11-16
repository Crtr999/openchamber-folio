/** Mistral admin console entry. The subscription page carries the included
 * monthly allowances the header meter reads; account data stays in the website. */
export const MISTRAL_URL = 'https://admin.mistral.ai/subscription';
export const MISTRAL_PARTITION = 'persist:open-carter-mistral';

/** Exact observed console links only, never inferred paths. */
export function mistralPageUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.origin !== new URL(MISTRAL_URL).origin || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Live page titles are display metadata, never identifiers. */
export function mistralPageTitle(url: string, title: string): string {
  try {
    if (new URL(url).origin !== new URL(MISTRAL_URL).origin) return '';
    return title.trim().slice(0, 200);
  } catch {
    return '';
  }
}

import { z } from 'zod';

const chatPathSchema = z.string().regex(/^\/(?:c\/[a-zA-Z0-9-]+|g\/[a-zA-Z0-9_-]+\/c\/[a-zA-Z0-9-]+)$/);
const pagePathSchema = z.string().regex(/^\/(?:c\/[a-zA-Z0-9-]+|g\/[a-zA-Z0-9_/-]+)?$/);
const entrySchema = z.object({ path: pagePathSchema, title: z.string().trim().min(1).max(1000) });
export const websiteSnapshotSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), account: z.string().min(1), path: z.string(), chats: z.array(entrySchema), projects: z.array(entrySchema), integratedAvailable: z.boolean() }),
  z.object({ kind: z.literal('signed-out') }),
  z.object({ kind: z.literal('unavailable') }),
]);
export type WebsiteSnapshot = z.infer<typeof websiteSnapshotSchema>;
export type ChatGPTEntry = z.infer<typeof entrySchema>;
type WebsiteAction =
  | { kind: 'snapshot'; integrated: boolean }
  | { kind: 'shortcut'; label: 'Library' | 'Plugins' | 'Explore' | 'Projects' | 'Scheduled' | 'Health' }
  | { kind: 'older' }
  | { kind: 'navigate'; path: string };

export const isChatGPTChatPath = (path: string): boolean => chatPathSchema.safeParse(path).success;
export const isChatGPTPagePath = (path: string): boolean => pagePathSchema.safeParse(path).success;
export const isChatGPTOrigin = (raw: string): boolean => {
  try { return new URL(raw).origin === 'https://chatgpt.com'; } catch { return false; }
};

/** Runs in the isolated website, never reads tokens, cookies or application stores. */
function operateWebsite(action: WebsiteAction) {
  if (location.origin !== 'https://chatgpt.com') return { kind: 'unavailable' };
  const styleId = 'open-carter-chatgpt-layout';
  if ((action.kind === 'snapshot' && !action.integrated) || (action.kind === 'shortcut' && action.label === 'Health')) {
    document.getElementById(styleId)?.remove();
    for (const el of document.querySelectorAll('[data-open-carter-sidebar]')) {
      el.removeAttribute('data-open-carter-sidebar'); el.removeAttribute('aria-hidden'); el.removeAttribute('inert');
    }
  }
  const chatLink = document.querySelector('a[href^="/c/"], a[href*="/c/"]');
  let sidebar = document.querySelector('#stage-sidebar, #stage-slideover-sidebar, [data-testid="sidebar"]')
    || chatLink?.closest('aside, nav') || document.querySelector('nav[aria-label="Chat history"]');
  const profile = document.querySelector('[aria-label="Open profile menu"], [data-testid="accounts-profile-button"]');
  if (!profile && Array.from(document.querySelectorAll('button, a')).some(el => /^(Log in|Sign up)$/.test((el.textContent || '').trim()))) {
    return { kind: 'signed-out' };
  }
  if (!sidebar || !profile) return { kind: 'unavailable' };
  // The site can put history in a nav nested inside the full sidebar column.
  // Hide that column, including its profile/footer, while preserving main content.
  const main = document.querySelector('main, [role="main"], #prompt-textarea');
  for (let parent = sidebar.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    if (main && parent.contains(main)) break;
    if (parent.contains(profile)) sidebar = parent;
  }
  if (action.kind === 'navigate') {
    if (!/^\/(?:c\/[a-zA-Z0-9-]+|g\/[a-zA-Z0-9_/-]+)?$/.test(action.path)) return false;
    let control = Array.from(sidebar.querySelectorAll('a[href]')).find(el => { const target: URL = new URL(el.getAttribute('href') || '', location.origin); return target.origin === location.origin && target.pathname === action.path; });
    if (!control && action.path === '/') control = Array.from(sidebar.querySelectorAll('button, a')).find(el => (el.textContent || '').trim() === 'New chat' || el.getAttribute('aria-label') === 'New chat');
    if (!(control instanceof HTMLElement)) return false;
    control.click(); return true;
  }
  if (action.kind === 'shortcut') {
    const control = Array.from(sidebar.querySelectorAll('button, a, [role="button"]'))
      .find(el => (el.textContent || '').trim() === action.label || el.getAttribute('aria-label') === action.label);
    if (control instanceof HTMLAnchorElement && new URL(control.href, location.origin).origin !== location.origin) return false;
    if (!(control instanceof HTMLElement)) {
      if (action.label !== 'Projects') return false;
      const heading = Array.from(sidebar.querySelectorAll('[role="button"], h2, h3, span, div')).find(el => (el.textContent || '').trim() === 'Projects');
      if (!heading) return false;
      heading.scrollIntoView({ block: 'nearest' }); return true;
    }
    control.click();
    return true;
  }
  if (action.kind === 'older') {
    const scroller = [sidebar, ...Array.from(sidebar.querySelectorAll('*'))]
      .filter(el => el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 50)
      .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight))[0];
    if (!scroller) return false;
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    return true;
  }
  let style = document.getElementById(styleId);
  if (action.integrated) {
    if (!style) { style = document.createElement('style'); style.id = styleId; document.head.appendChild(style); }
    // Retain the original scroll viewport for ChatGPT's history paging.
    const css = '[data-open-carter-sidebar] { position: fixed !important; inset: 0 auto 0 0 !important; width: 260px !important; height: 100vh !important; opacity: 0 !important; pointer-events: none !important; z-index: -1 !important; }';
    if (style.textContent !== css) style.textContent = css;
    sidebar.setAttribute('data-open-carter-sidebar', '');
    sidebar.setAttribute('aria-hidden', 'true');
    sidebar.setAttribute('inert', '');
  } else {
    style?.remove();
    sidebar.removeAttribute('data-open-carter-sidebar');
    sidebar.removeAttribute('aria-hidden');
    sidebar.removeAttribute('inert');
  }
  const chats: Array<{ path: string; title: string }> = [];
  const projects: Array<{ path: string; title: string }> = [];
  const seen = new Set<string>();
  for (const link of Array.from(sidebar.querySelectorAll('a[href]'))) {
    const url: URL = new URL(link.getAttribute('href') || '', location.origin);
    const path = url.pathname;
    const title = (link.getAttribute('title') || link.textContent || '').trim();
    if (url.origin !== location.origin || !title || seen.has(path)) continue;
    if (/^\/(?:c\/[a-zA-Z0-9-]+|g\/[a-zA-Z0-9_-]+\/c\/[a-zA-Z0-9-]+)$/.test(path)) { chats.push({ path, title }); seen.add(path); }
    else if (/^\/g\/[a-zA-Z0-9_/-]+\/project$/.test(path)) { projects.push({ path, title }); seen.add(path); }
  }
  if (/^\/(?:c\/[a-zA-Z0-9-]+|g\/[a-zA-Z0-9_-]+\/c\/[a-zA-Z0-9-]+)$/.test(location.pathname) && !seen.has(location.pathname)) {
    const title = document.title.replace(/(?:\s[-|]\s)?ChatGPT$/, '').trim();
    if (title) chats.unshift({ path: location.pathname, title });
  }
  const account = (profile.parentElement?.textContent || profile.textContent || profile.getAttribute('aria-label') || '').trim();
  return { kind: 'ready', account, path: location.pathname, chats, projects, integratedAvailable: true };
}

export const buildWebsiteScript = (action: WebsiteAction): string => `(${operateWebsite.toString()})(${JSON.stringify(action)})`;

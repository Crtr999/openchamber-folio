import { z } from 'zod';

type WebsiteAccount = 'venice' | 'gemini';
const messageSchema = z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(350_000), rich: z.boolean() });
export const websiteChatSnapshotSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), url: z.string().url(), account: z.string().min(1).max(1000), messages: z.array(messageSchema).max(120), busy: z.boolean(), draft: z.string().max(350_000), partial: z.boolean(), userCount: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('website-required'), reason: z.enum(['route', 'account', 'composer', 'messages']).optional() }),
]);
export const websiteChatActionSchema = z.object({ kind: z.enum(['submitted', 'drafted', 'stopped', 'unavailable', 'busy', 'draft-conflict', 'page-changed', 'website-required']) });
type WebsiteChatAction =
  | { kind: 'snapshot' }
  | { kind: 'send' | 'draft'; text: string; url: string; expectedDraft: string }
  | { kind: 'stop'; url: string };

/** Operates only visible conversation DOM and ordinary website controls.
 * Never reads cookies, tokens, browser storage, network responses or account fields.
 * Kept self-contained because Electron executes its compiled body in the guest.
 */
function operateChat(provider: WebsiteAccount, action: WebsiteChatAction) {
  const origin = provider === 'venice' ? 'https://venice.ai' : 'https://gemini.google.com';
  const chatPath = provider === 'venice' ? /^\/chat\/classic(?:\/[^/]+)?$/ : /^\/app(?:\/[^/]+)?$/;
  if (location.origin !== origin || !chatPath.test(location.pathname)) return { kind: 'website-required', reason: 'route' };
  const pageUrl = location.origin + location.pathname;
  const controls = Array.from(document.querySelectorAll('button, [role="button"]')).slice(0, 2000);
  const label = (el: Element) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
  const accountControl = provider === 'gemini' ? document.querySelector('a[href*="SignOutOptions"]')
    : controls.find(el => /[^\s@]+@[^\s@]+\.[^\s@]+/.test(el.textContent || el.getAttribute('aria-label') || ''));
  const account = accountControl ? (provider === 'venice'
    ? (accountControl.textContent || accountControl.getAttribute('aria-label') || '').match(/[^\s@]+@[^\s@]+\.[^\s@]+/)?.[0] || ''
    : label(accountControl).slice(0, 1000)) : '';
  if (!account) return { kind: 'website-required', reason: 'account' };
  const stop = controls.find(el => /^(stop response|stop generating|stop generation|stop)$/i.test(label(el)));
  const editorSelectors = provider === 'gemini'
    ? ['[contenteditable="true"][aria-label*="prompt" i]', 'textarea[aria-label*="prompt" i]', 'rich-textarea [contenteditable="true"]', '[contenteditable="true"][role="textbox"]', '[contenteditable="true"][data-lexical-editor="true"]', '.ProseMirror[contenteditable="true"]']
    : ['textarea[placeholder]', 'textarea[aria-label]', '[contenteditable="true"][role="textbox"]'];
  const visibleEditor = (element: Element) => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };
  const input = editorSelectors.flatMap(selector => Array.from(document.querySelectorAll(selector))).find(visibleEditor);
  if (!(input instanceof HTMLElement) || input.closest('[role="dialog"]')) return { kind: 'website-required', reason: 'composer' };
  const draft = input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement ? input.value : input.innerText;
  if (action.kind === 'stop') {
    if (action.url !== pageUrl) return { kind: 'page-changed' };
    if (!(stop instanceof HTMLElement)) return { kind: 'unavailable' };
    stop.click(); return { kind: 'stopped' };
  }
  if (action.kind === 'send' || action.kind === 'draft') {
    if (action.url !== pageUrl) return { kind: 'page-changed' };
    if (stop) return { kind: 'busy' };
    if ((action.kind === 'send' && !action.text.trim()) || action.text.length > 300_000) return { kind: 'unavailable' };
    if (draft !== action.expectedDraft) return { kind: 'draft-conflict' };
    input.focus();
    if (input instanceof HTMLTextAreaElement) Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, action.text);
    else if (input instanceof HTMLInputElement) Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, action.text);
    else {
      // Native editing keeps rich-editor framework state aligned with its DOM.
      const selection = window.getSelection(), range = document.createRange();
      range.selectNodeContents(input); selection?.removeAllRanges(); selection?.addRange(range);
      if (!document.execCommand?.('insertText', false, action.text)) input.textContent = action.text;
    }
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: action.text }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (action.kind === 'draft') return { kind: 'drafted' };
    // Website frameworks enable their own Send button after the input event.
    return new Promise(resolve => {
      const deadline = Date.now() + 5000;
      const submitWhenReady = () => {
        if (location.origin + location.pathname !== pageUrl) { resolve({ kind: 'page-changed' }); return; }
        if (!input.isConnected) { resolve({ kind: 'unavailable' }); return; }
        // Rich editors replace their DOM after native editing. The submitted
        // user message, not this temporary editor representation, acknowledges
        // the exact payload. Existing user drafts were checked before editing.
        const send = Array.from(document.querySelectorAll('button, [role="button"]'))
          .find(el => /^(submit chat|send message|send prompt|send)$/i.test(label(el)) && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true');
        if (send instanceof HTMLElement) { send.click(); resolve({ kind: 'submitted' }); return; }
        if (Date.now() >= deadline) { resolve({ kind: 'unavailable' }); return; }
        setTimeout(submitWhenReady, 100);
      };
      setTimeout(submitWhenReady, 100);
    });
  }
  // Read text from message bodies only. Website HTML never crosses into app HTML.
  const readable = (el: Element) => {
    const clone = el.cloneNode(true);
    if (!(clone instanceof HTMLElement)) return '';
    for (const control of clone.querySelectorAll('button, [role="button"], svg, script, style')) control.remove();
    for (const pre of clone.querySelectorAll('pre')) pre.replaceWith(document.createTextNode('\n```\n' + (pre.textContent || '') + '\n```\n'));
    for (const br of clone.querySelectorAll('br')) br.replaceWith(document.createTextNode('\n'));
    for (const block of clone.querySelectorAll('p, li, h1, h2, h3, h4, tr')) block.appendChild(document.createTextNode('\n\n'));
    return (clone.textContent || '').trim().slice(0, 350_000);
  };
  const rows: Array<{ el: Element; role: 'user' | 'assistant' }> = [];
  if (provider === 'gemini') {
    for (const el of document.querySelectorAll('user-query, model-response')) rows.push({ el, role: el.tagName.toLowerCase() === 'user-query' ? 'user' : 'assistant' });
  } else {
    for (const el of document.querySelectorAll('[data-message-author-role], [data-message-role]')) {
      const role = el.getAttribute('data-message-author-role') || el.getAttribute('data-message-role');
      if (role === 'user' || role === 'assistant') rows.push({ el, role });
    }
    // Venice marks every message with data-message-id; only user messages carry
    // the chat-user-msg-actions toolbar (Copy / Edit Response).
    if (!rows.length) for (const el of document.querySelectorAll('[data-message-id]')) {
      rows.push({ el: el.querySelector('[data-message-content="true"]') || el, role: el.querySelector('.chat-user-msg-actions') ? 'user' : 'assistant' });
    }
    if (!rows.length) {
      // Venice exposes Copy/Edit actions on the owning message. Walk only to
      // the first ancestor containing body text and exactly one Copy action.
      const isCopy = (btn: Element) => /^copy(?: message| response| text)?$/i.test(label(btn)) && !btn.closest('pre');
      for (const copy of controls.filter(isCopy)) {
        for (let el = copy.parentElement, depth = 0; el && depth < 7; el = el.parentElement, depth++) {
          if (Array.from(el.querySelectorAll('button, [role="button"]')).filter(isCopy).length > 1) break;
          const text = readable(el);
          if (!text || el.contains(input) || rows.some(row => row.el === el || el.contains(row.el))) continue;
          const edit = Array.from(el.querySelectorAll('button, [role="button"]')).some(button => /^edit(?: message| prompt| response)?(?:\b.*)?$/i.test(label(button)));
          rows.push({ el, role: edit ? 'user' : 'assistant' }); break;
        }
      }
    }
  }
  rows.sort((a, b) => a.el === b.el ? 0 : a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  let bytes = 0;
  const selected = rows.slice(-120);
  const messages = selected.map(({ el, role }) => {
    const body = provider === 'gemini' ? el.querySelector(role === 'user' ? '.query-text, .user-query-content, .query-content' : '.model-response-text, .markdown, message-content') || el : el;
    const text = readable(body); bytes += text.length;
    return { role, text, rich: Boolean(body.querySelector('img, video, audio, canvas, iframe, input[type="file"]')) };
  }).filter(row => row.text);
  // A conversation route with unrecognized message markup is failure, not empty history.
  const isConversation = provider === 'gemini' ? /^\/app\/[^/]+$/.test(location.pathname) : /^\/chat\/classic\/[^/]+$/.test(location.pathname);
  if (isConversation && messages.length === 0 && !stop) return { kind: 'website-required', reason: 'messages' };
  while (bytes > 500_000 && messages.length > 1) bytes -= messages.shift()?.text.length || 0;
  return { kind: 'ready', url: pageUrl, account, messages, busy: Boolean(stop), draft: draft.slice(0, 350_000), partial: messages.length < rows.length, userCount: rows.filter(row => row.role === 'user').length };
}

export const websiteAccountActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('selected') }),
  z.object({ kind: z.literal('unavailable'), reason: z.string().max(300) }),
  z.object({ kind: z.literal('names'), names: z.array(z.string().max(120)).max(300), paid: z.array(z.string().max(120)).max(300) }),
  z.object({ kind: z.literal('gemini-usage'), plan: z.string().max(40).nullable(), windows: z.array(z.object({ key: z.enum(['session', 'weekly']), usedPercent: z.number(), resetText: z.string().max(80).nullable() })).max(4) }),
  z.object({ kind: z.literal('venice-usage'), plan: z.string().max(40).nullable(), balance: z.string().max(30).nullable(), limits: z.array(z.object({ label: z.string().max(40), remaining: z.number(), resetText: z.string().max(40).nullable() })).max(12) }),
  z.object({ kind: z.literal('failed'), reason: z.string().max(300) }),
]);
type WebsiteAccountAction = { kind: 'models' } | { kind: 'select-model'; name: string } | { kind: 'usage' };

/** Reads and operates only ordinary website controls: the model picker and the
 * account's own usage and limits pages. Like operateChat, it never reads
 * cookies, tokens, storage or network responses, and it is self-contained
 * because Electron runs its compiled body inside the guest.
 */
async function operateAccount(provider: WebsiteAccount, action: WebsiteAccountAction) {
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const label = (el: Element) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
  const waitFor = async (get: () => unknown, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const value = get(); if (value) return value; await sleep(150); }
    return null;
  };
  const click = (el: Element) => { (el as HTMLElement).click(); };
  const textLines = () => (document.body.innerText || '').split('\n').map(line => line.trim()).filter(Boolean);
  const origin = provider === 'venice' ? 'https://venice.ai' : 'https://gemini.google.com';
  if (location.origin !== origin) return { kind: 'failed', reason: 'The website is not showing its own page.' };

  // ----- model picker -----
  const veniceButton = () => {
    const box = document.querySelector('textarea[placeholder]');
    let root: Element | null = box;
    while (root && !Array.from(root.querySelectorAll('button')).some(b => /^submit chat$/i.test(label(b)))) root = root.parentElement;
    if (!root) return null;
    // The picker button sits right after Settings; later buttons (Purchase credits, Submit) vary.
    const all = Array.from(root.querySelectorAll('button'));
    const after = all.findIndex(b => /^settings$/i.test(label(b)));
    const next = after >= 0 ? all[after + 1] : undefined;
    if (next && !/^(submit chat|purchase credits)$/i.test(label(next))) return next;
    const buttons = all.filter(b => { const t = label(b); return t && !/^(dictate|actions|settings|submit chat|purchase credits|stop.*|attach.*)$/i.test(t); });
    return buttons[0] ?? null;
  };
  const veniceRows = () => Array.from(document.querySelectorAll('.model-switcher-scroll-container [role="group"]'))
    .filter(row => row.querySelector('p'))
    .map(row => ({ row, name: (row.querySelector('p')?.textContent || '').trim(), available: Number(getComputedStyle(row).opacity) >= 0.9, paid: Boolean(row.querySelector('svg path[d^="M9 14c0 1.657"]')) }));
  const geminiButton = () => document.querySelector('[data-test-id="bard-mode-menu-button"]');
  const geminiOptions = () => Array.from(document.querySelectorAll('[data-test-id^="bard-mode-option-"]'))
    .map(el => ({ el, name: ((el as HTMLElement).innerText || '').split('\n')[0].trim(), available: el.getAttribute('aria-disabled') !== 'true' && !el.hasAttribute('disabled'), paid: false }));
  const openPicker = async () => {
    // The picker button can appear a moment after the composer does.
    const button = await waitFor(() => (provider === 'venice' ? veniceButton() : geminiButton()), 10000);
    if (!button) return false;
    const count = () => (provider === 'venice' ? veniceRows().length : geminiOptions().length);
    // A freshly loaded page can show the button before its click handler is attached, so try again if nothing opened.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (count() > 0) return true;
      const target = (provider === 'venice' ? veniceButton() : geminiButton()) ?? button;
      click(target as Element);
      if (await waitFor(() => count() > 0, 3500)) return true;
      await sleep(1500);
    }
    return false;
  };
  const closePicker = async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(250);
    if ((provider === 'venice' ? veniceRows().length : geminiOptions().length) > 0) { const button = provider === 'venice' ? veniceButton() : geminiButton(); if (button) click(button); await sleep(250); }
  };

  if (action.kind === 'models') {
    if (!(await openPicker())) return { kind: 'failed', reason: 'The model picker did not open.' };
    const entries = provider === 'venice' ? veniceRows() : geminiOptions();
    const usable = entries.filter(entry => entry.available && entry.name);
    await closePicker();
    return { kind: 'names', names: usable.map(entry => entry.name), paid: usable.filter(entry => entry.paid).map(entry => entry.name) };
  }
  if (action.kind === 'select-model') {
    if (!(await openPicker())) return { kind: 'failed', reason: 'The model picker did not open.' };
    const wanted = action.name.trim().toLowerCase();
    const entries = provider === 'venice' ? veniceRows() : geminiOptions();
    const hit = entries.find(entry => entry.name.toLowerCase() === wanted);
    if (!hit) { await closePicker(); return { kind: 'unavailable', reason: action.name + ' is not in this website account’s model list.' }; }
    if (!hit.available) { await closePicker(); return { kind: 'unavailable', reason: action.name + ' is locked on this website account’s plan.' }; }
    const target = 'row' in hit ? hit.row : hit.el;
    target.scrollIntoView?.({ block: 'center' });
    click(target);
    const closed = await waitFor(() => (provider === 'venice' ? veniceRows().length : geminiOptions().length) === 0, 4000);
    if (!closed) await closePicker();
    await sleep(400);
    return { kind: 'selected' };
  }

  // ----- usage -----
  if (provider === 'gemini') {
    const found = await waitFor(() => /\d+%\s*used/i.test(document.body.innerText || ''), 15000);
    if (!found) return { kind: 'failed', reason: 'Gemini’s usage page did not show any limits. Sign in through the account connection.' };
    await sleep(500);
    const lines = textLines();
    const windows: Array<{ key: 'session' | 'weekly'; usedPercent: number; resetText: string | null }> = [];
    for (const [key, heading] of [['session', /^current usage/i], ['weekly', /^weekly limit/i]] as const) {
      const start = lines.findIndex(line => heading.test(line));
      if (start < 0) continue;
      let used: number | null = null, reset: string | null = null;
      for (const line of lines.slice(start + 1, start + 8)) {
        if (/^(current usage|weekly limit)/i.test(line)) break;
        const pct = line.match(/(\d+(?:\.\d+)?)%\s*used/i); if (pct && used === null) used = Number(pct[1]);
        if (/^resets?\b/i.test(line) && reset === null) reset = line.replace(/^resets?\s*/i, '').slice(0, 80);
      }
      if (used !== null) windows.push({ key, usedPercent: used, resetText: reset });
    }
    const head = lines.findIndex(line => /^usage limits/i.test(line));
    const plan = head >= 0 ? (lines.slice(head, head + 3).find(line => /^(free|pro|plus|ultra|ai pro|ai ultra)$/i.test(line)) ?? null) : null;
    return { kind: 'gemini-usage', plan: plan ? plan[0].toUpperCase() + plan.slice(1).toLowerCase() : null, windows };
  }
  // Venice: account menu → Settings → Storage and Limits / Usage tabs.
  const account = document.querySelector('[data-testid="account-menu"]');
  if (!account) return { kind: 'failed', reason: 'Venice is not signed in. Sign in through the account connection.' };
  click(account);
  const settings = await waitFor(() => Array.from(document.querySelectorAll('[role="menuitem"]')).find(el => /^settings/i.test((el.textContent || '').trim())));
  if (!settings) return { kind: 'failed', reason: 'Venice’s account menu did not open.' };
  click(settings as Element);
  const tab = (name: string) => Array.from(document.querySelectorAll('[role="tab"], button, a')).find(el => (el.textContent || '').trim() === name);
  const limitsTab = await waitFor(() => tab('Storage and Limits'));
  if (!limitsTab) return { kind: 'failed', reason: 'Venice’s settings did not open.' };
  click(limitsTab as Element);
  await waitFor(() => /remaining until/i.test(document.body.innerText || ''), 8000);
  await sleep(300);
  const lines = textLines();
  const limits: Array<{ label: string; remaining: number; resetText: string | null }> = [];
  lines.forEach((line, index) => {
    const m = line.match(/^(\d+)\s+remaining(?:\s+until\s+(.+))?$/i);
    if (m && index > 0 && limits.length < 12) limits.push({ label: lines[index - 1].slice(0, 40), remaining: Number(m[1]), resetText: m[2] ? m[2].slice(0, 40) : null });
  });
  let balance: string | null = null;
  const usageTab = tab('Usage');
  if (usageTab) {
    click(usageTab);
    await waitFor(() => /usd balance/i.test(document.body.innerText || ''), 5000);
    const after = textLines();
    const at = after.findIndex(line => /^usd balance/i.test(line));
    if (at >= 0) balance = (after[at].replace(/^usd balance:?\s*/i, '') || after[at + 1] || '').slice(0, 30) || null;
  }
  const plan = /upgrade to venice pro/i.test(document.body.innerText || '') ? 'Free' : null;
  return { kind: 'venice-usage', plan, balance, limits };
}

export const buildWebsiteAccountScript = (provider: WebsiteAccount, action: WebsiteAccountAction): string => `(${operateAccount.toString()})(${JSON.stringify(provider)},${JSON.stringify(action)})`;

export const buildWebsiteChatScript = (provider: WebsiteAccount, action: WebsiteChatAction): string => `(${operateChat.toString()})(${JSON.stringify(provider)},${JSON.stringify(action)})`;

/** Website route changes replace the composer briefly after a send. Only reads
 * are retried: the caller remains responsible for the single submitted turn. */
export async function waitForWebsiteSnapshot({ read, ensureActive, wait, now = Date.now }: {
  read: () => Promise<z.infer<typeof websiteChatSnapshotSchema>>;
  ensureActive: () => Promise<void>;
  wait: () => Promise<void>;
  now?: () => number;
}): Promise<Extract<z.infer<typeof websiteChatSnapshotSchema>, { kind: 'ready' }>> {
  const deadline = now() + 30_000;
  let lastReason = 'loading';
  while (true) {
    await ensureActive();
    try {
      const snapshot = await read();
      if (snapshot.kind === 'ready') return snapshot;
      lastReason = snapshot.reason ?? 'loading';
    } catch { /* The guest can be between documents during navigation. */ }
    if (now() >= deadline) throw new Error('The website conversation did not finish loading (' + lastReason + '). Open its account connection to check the pending reply before retrying.');
    await wait();
  }
}

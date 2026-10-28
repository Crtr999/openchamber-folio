import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Event: browser.Event, KeyboardEvent: browser.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { HomeSuggestionRow } = await import('./HomeSuggestionRow');
afterAll(async () => {
  await browser.happyDOM.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('inline suggestion exposes real source detail to focus and never submits the surrounding composer', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const item = { id: 'ses_review', projectId: 'studio', directory: '/work/studio', friend: 'Studio', title: 'Daily review',
    excerpt: '## Prepare the review\nConfirmed review at 14:00, source: calendar.', createdAt: Date.UTC(2026, 9, 28, 12), seen: false, dismissed: false };
  let opened = 0; let dismissed = 0; let submitted = 0;
  const render = (pending: boolean) => <I18nProvider><form onSubmit={event => { event.preventDefault(); submitted++; }}>
    <ul><HomeSuggestionRow item={item} pending={pending} onOpen={() => opened++} onDismiss={() => dismissed++} /></ul>
  </form></I18nProvider>;
  try {
    await act(async () => root.render(render(false)));
    const main = host.querySelector<HTMLButtonElement>('.oc-home-suggestion-main');
    if (!main) throw new Error('Missing suggestion action');
    expect(main.textContent).toBe('Prepare the review');
    const detail = document.getElementById(main.getAttribute('aria-describedby') || '');
    expect(detail?.textContent).toContain('Studio');
    expect(detail?.textContent).toContain('source: calendar.');
    expect(detail?.querySelector('time')?.dateTime).toBe('2026-10-28T12:00:00.000Z');
    await act(async () => main.focus());
    expect(document.activeElement).toBe(main);
    await act(async () => main.click());
    expect(opened).toBe(1);
    const dismiss = host.querySelector<HTMLButtonElement>('.oc-home-suggestion-dismiss');
    expect(dismiss?.getAttribute('aria-label')).toContain('Prepare the review');
    await act(async () => dismiss?.click());
    expect(dismissed).toBe(1);
    await act(async () => root.render(render(true)));
    expect(host.querySelector<HTMLButtonElement>('.oc-home-suggestion-dismiss')?.disabled).toBe(true);
    expect(Array.from(host.querySelectorAll('button')).every(button => button.type === 'button')).toBe(true);
    expect(submitted).toBe(0);
    expect(host.querySelector('.oc-home-card')).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

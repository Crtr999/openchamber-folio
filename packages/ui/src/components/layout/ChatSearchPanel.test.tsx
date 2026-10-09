import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator,
    localStorage: browser.localStorage, HTMLElement: browser.HTMLElement, Element: browser.Element, Event: browser.Event,
    KeyboardEvent: browser.KeyboardEvent, PointerEvent: browser.PointerEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
}
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ChatSearchPanel } = await import('./ChatSearchPanel');
afterAll(async () => {
    await browser.happyDOM.close();
    for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
});

test('sidebar trigger opens the quick palette; the advanced panel opens on request and closes outside and on Escape', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<I18nProvider><ChatSearchPanel /></I18nProvider>));
    const trigger = host.querySelector('button'); if (!trigger) throw new Error('Search trigger missing');
    const panel = () => document.querySelector('section[role="region"]');
    let paletteRequests = 0;
    const onPalette = () => { paletteRequests += 1; };
    window.addEventListener('open-carter:search-palette', onPalette);
    try {
        await act(async () => { trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); trigger.click(); });
        expect(paletteRequests).toBe(1); expect(panel()).toBeNull();
        await act(async () => window.dispatchEvent(new Event('open-carter:advanced-chat-search')));
        expect(panel()).not.toBeNull(); expect(document.querySelector('[role="dialog"]')).toBeNull();
        await act(async () => panel()?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
        expect(panel()).not.toBeNull();
        await act(async () => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
        expect(panel()).toBeNull(); expect(trigger.getAttribute('aria-expanded')).toBe('false');
        await act(async () => window.dispatchEvent(new Event('open-carter:advanced-chat-search')));
        expect(document.querySelectorAll('section[role="region"]')).toHaveLength(1);
        await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
        expect(panel()).toBeNull(); expect(document.activeElement).toBe(trigger);
        await act(async () => root.render(<I18nProvider><ChatSearchPanel enabled={false} /></I18nProvider>));
        await act(async () => window.dispatchEvent(new Event('open-carter:advanced-chat-search')));
        expect(panel()).toBeNull();
    } finally { window.removeEventListener('open-carter:search-palette', onPalette); await act(async () => root.unmount()); host.remove(); }
});

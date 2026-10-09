import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator,
    HTMLElement: browser.HTMLElement, Element: browser.Element, Event: browser.Event, KeyboardEvent: browser.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
}
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { HomeTaskComposer } = await import('./HomeTaskComposer');
afterAll(async () => {
    await browser.happyDOM.close();
    for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
});

test('compact task control expands, preserves a draft, submits once and collapses empty blur/Escape', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    const submissions: string[] = [];
    function Fixture() {
        const [value, setValue] = React.useState('');
        return <HomeTaskComposer value={value} onChange={setValue} disabled={false}
            onSubmit={() => { submissions.push(value); setValue(''); }} />;
    }
    await act(async () => root.render(<I18nProvider><Fixture /></I18nProvider>));
    const open = async () => {
        await act(async () => host.querySelector('button')?.click());
        const input = host.querySelector('input'); if (!input) throw new Error('Task input missing'); return input;
    };
    try {
        expect(host.querySelector('input')).toBeNull();
        let input = await open();
        expect(document.activeElement).toBe(input);
        await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        expect(host.querySelector('input')).toBeNull();
        input = await open();
        const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
        await act(async () => { setter?.call(input, 'Fixture task'); input.dispatchEvent(new Event('input', { bubbles: true })); });
        await act(async () => input.blur());
        expect(host.querySelector('input')?.value).toBe('Fixture task');
        await act(async () => host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
        expect(submissions).toEqual(['Fixture task']);
        expect(host.querySelector('input')).toBeNull();
        await act(async () => host.querySelector('button')?.focus());
        const focusedInput = host.querySelector('input');
        expect(focusedInput).not.toBeNull();
        expect(document.activeElement).toBe(focusedInput);
        await act(async () => focusedInput?.blur());
        expect(host.querySelector('input')).toBeNull();
        expect(submissions).toHaveLength(1);
    } finally { await act(async () => root.unmount()); host.remove(); }
});

import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

type Read = { rows: Array<{ providerJobId: string; name: string; kind: string; status: string; rrule: string; providerThreadId: string; createdAt: number; updatedAt: number; schedule: { understood: boolean; summary: string; timeZone: string | null; nextRunAt: number | null } }>; readAt: number; partial: boolean; skipped: string[]; error?: string };

const daily: Read['rows'][number] = { providerJobId: 'kelby-research', name: 'Kelby research evidence', kind: 'heartbeat', status: 'ACTIVE', rrule: 'FREQ=DAILY;BYHOUR=18;BYMINUTE=15;BYSECOND=0', providerThreadId: '01a145f6-aef5-7982-83f0-a944d36b50c8', createdAt: 1, updatedAt: 2, schedule: { understood: true, summary: 'Every day at 18:15', timeZone: 'America/New_York', nextRunAt: Date.parse('2026-10-18T22:15:00Z') } };
const paused: Read['rows'][number] = { providerJobId: 'kelby-speed', name: 'Kelby paper speed test', kind: 'heartbeat', status: 'PAUSED', rrule: 'FREQ=MONTHLY', providerThreadId: '01a147b3-f589-7682-b8c4-4638fa4eaa26', createdAt: 1, updatedAt: 2, schedule: { understood: false, summary: '', timeZone: 'America/New_York', nextRunAt: null } };
const untimed: Read['rows'][number] = { ...daily, providerJobId: 'kelby-untimed', name: 'Kelby untimed', rrule: 'FREQ=DAILY', schedule: { understood: true, summary: 'Every day', timeZone: 'America/New_York', nextRunAt: null } };
const read = (overrides: Partial<Read> = {}): Read => ({ rows: [], readAt: Date.parse('2026-10-18T12:00:00Z'), partial: false, skipped: [], ...overrides });

function installDom<Result>(invoke: (command: string, args: { action?: string }) => Promise<Result>) {
    const dom = new Window({ url: 'http://localhost' });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    const globals = {
        window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
        Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, HTMLButtonElement: dom.HTMLButtonElement, Node: dom.Node,
        customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet, Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent,
        MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
        requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [name, value] of Object.entries(globals)) {
        originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    Object.defineProperty(dom, '__OPENCHAMBER_ELECTRON__', { configurable: true, value: { runtime: 'electron' } });
    Object.defineProperty(dom, '__OPENCHAMBER_DESKTOP__', { configurable: true, value: { invoke } });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => new Promise<Response>(() => {}), previousFetch);
    return { dom, restore() {
        globalThis.fetch = previousFetch;
        dom.happyDOM.cancelAsync();
        for (const [name, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    } };
}

test('rows show their provider identities read-only, and a failed read keeps them with the error', async () => {
    let result: Read = read({ rows: [daily, paused, untimed] });
    const requests: Array<{ action?: string }> = [];
    const harness = installDom(async (_command, args) => { requests.push(args); return result; });
    const { createRoot } = await import('react-dom/client');
    const { I18nProvider } = await import('@/lib/i18n');
    const { HomeChatGPTTasks } = await import('./HomeChatGPTTasks');
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    const text = () => container.textContent ?? '';
    const refresh = () => {
        const button = container.querySelector('button[aria-label="Refresh"]');
        if (!(button instanceof HTMLButtonElement)) throw new Error('Missing refresh control');
        return button.click();
    };
    try {
        await act(async () => root.render(<I18nProvider><HomeChatGPTTasks /></I18nProvider>));
        expect(requests).toEqual([{ action: 'chatgpt-automations-list' }]);
        expect(text()).toContain('Kelby research evidence');
        expect(text()).toContain('Every day at 18:15');
        expect(text()).toContain('ChatGPT thread 01a145f6-aef5-7982-83f0-a944d36b50c8');
        expect(text()).toContain('task id kelby-research');
        expect(text()).toContain('Active');
        expect(text()).toContain('Paused');
        // An unmodelled rule says so without inventing a run; a readable cadence with
        // no stated time keeps its cadence and still says the next run is unknown.
        expect(text()).toContain('Schedule unknown');
        expect(text()).toContain('Every day · next run unknown');
        expect(text()).toContain('Read-only');
        // No row carries a control that could run or change the external job.
        expect(container.querySelectorAll('a')).toHaveLength(0);
        expect([...container.querySelectorAll('button')].map((item) => item.getAttribute('aria-label'))).toEqual(['Refresh']);

        // A read failure keeps the last good rows visible and says what failed.
        result = read({ rows: [], error: 'EACCES: permission denied' });
        await act(async () => refresh());
        expect(text()).toContain('Kelby research evidence');
        expect(text()).toContain('EACCES: permission denied');
        expect(text()).not.toContain('no scheduled tasks');

        // An authoritative empty feed is different from a failed one.
        result = read();
        await act(async () => refresh());
        expect(text()).toContain('ChatGPT has no scheduled tasks');
        expect(text()).not.toContain('EACCES');
    } finally { await act(async () => root.unmount()); harness.restore(); }
});

test('loading, partial reads and a non-desktop runtime are distinct states', async () => {
    let resolveRead: (value: Read) => void = () => {};
    const pending = new Promise<Read>((resolve) => { resolveRead = resolve; });
    let reads = 0;
    let result: Read | Promise<Read> = pending;
    const harness = installDom(async () => { reads += 1; return result; });
    const { createRoot } = await import('react-dom/client');
    const { I18nProvider } = await import('@/lib/i18n');
    const { HomeChatGPTTasks } = await import('./HomeChatGPTTasks');
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    const text = () => container.textContent ?? '';
    try {
        await act(async () => root.render(<I18nProvider><HomeChatGPTTasks /></I18nProvider>));
        expect(text()).toContain('Loading');
        expect(text()).not.toContain('no scheduled tasks');
        await act(async () => resolveRead(read({ rows: [daily], partial: true, skipped: ['broken-one', 'broken-two'] })));
        expect(text()).toContain('2 task files could not be read');
        expect(text()).toContain('Kelby research evidence');

        // Home regaining focus reads again, and a hidden card stops reading.
        result = read({ rows: [daily] });
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
        expect(reads).toBe(2);
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
        expect(reads).toBe(2);
        await act(async () => root.unmount());
        expect(reads).toBe(2);

        // Outside the local desktop instance there is no feed to read.
        Object.defineProperty(harness.dom, '__OPENCHAMBER_ELECTRON__', { configurable: true, value: { runtime: 'web' } });
        const before = reads;
        const other = createRoot(document.createElement('div'));
        await act(async () => other.render(<I18nProvider><HomeChatGPTTasks /></I18nProvider>));
        expect(reads).toBe(before);
        await act(async () => other.unmount());
    } finally { await act(async () => root.unmount()); harness.restore(); }
});

test('the client rejects a host payload that breaks the row contract', async () => {
    // A row whose next run is not a real time must not survive the client parser.
    const harness = installDom(async () => read({ rows: [{ ...daily, schedule: { ...daily.schedule, nextRunAt: Number.NaN } }] }));
    try {
        const { readHomeChatGPTTasks } = await import('@/lib/personal-home');
        await expect(readHomeChatGPTTasks()).rejects.toThrow();
    } finally { harness.restore(); }
});
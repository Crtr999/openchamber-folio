import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, ResizeObserver: browser.ResizeObserver, MutationObserver: browser.MutationObserver, requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true })) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
}
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { HomePersonalPanels } = await import('./HomePersonalPanels');
const { useEnterprisePolicyStore } = await import('@/stores/useEnterprisePolicyStore');

afterAll(async () => {
    await browser.happyDOM.close();
    for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
});

async function fixture() {
    useEnterprisePolicyStore.setState({ enterpriseMode: false, networkAccessBlocked: false });
    const calls: string[] = [];
    let finish: (() => void) | undefined;
    let reject: ((error: Error) => void) | undefined;
    Object.defineProperty(browser, '__OPENCHAMBER_ELECTRON__', { configurable: true, value: { runtime: 'electron' } });
    Object.defineProperty(browser, '__OPENCHAMBER_DESKTOP__', { configurable: true, value: { invoke: async (_command: string, args: { action: string; status?: string }) => {
        calls.push(args.action);
        if (args.action === 'status') return { connected: true, signingIn: false, board: 'board', habits: 'habits', destination: 'parent' };
        if (args.action === 'board') return { name: 'Fixture', columns: ['To do', 'Worked Today', 'Done/Archived'], rows: [
            { url: 'https://www.notion.so/fixture-a', title: 'Calendar-day task', status: 'To do', due: { start: '2026-10-08', end: null, isDatetime: false } },
            { url: 'https://www.notion.so/fixture-b', title: 'Timed task', status: 'To do', due: { start: '2026-10-08T23:30:00-07:00', end: null, isDatetime: true } },
            { url: 'https://www.notion.so/fixture-c', title: 'No-date task', status: 'Worked Today', due: null },
        ], limited: false };
        if (args.action === 'habits') return { day: '2026-10-08', page: null, items: [] };
        if (args.action === 'calendar') return { access: 'unsupported' };
        if (args.action === 'create-task') return { saved: true };
        if (args.action === 'move') return new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; });
        throw new Error('Unexpected fixture operation');
    } } });
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<I18nProvider><HomePersonalPanels>{({ tasks }) => tasks}</HomePersonalPanels></I18nProvider>));
    const move = async () => {
        const button = browser.document.querySelector('button[aria-label="Move task"]');
        if (!button) throw new Error('Move control missing');
        await act(async () => button.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
        const option = [...browser.document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === 'Worked Today');
        if (!option) throw new Error('Configured status missing');
        // happy-dom does not synthesize the click that a browser's Enter emits.
        await act(async () => option.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, cancelable: true })));
    };
    return { host, calls, move, finish: () => act(async () => finish?.()), fail: () => act(async () => reject?.(new Error('Fixture write failed'))), cleanup: async () => { await act(async () => root.unmount()); host.remove(); } };
}

test('task cards show exact due dates without a status select and preserve real categories', async () => {
    const view = await fixture();
    try {
        expect(view.host.querySelector('[role="combobox"]')).toBeNull();
        expect([...view.host.querySelectorAll('[data-home-status]')].map((item) => item.getAttribute('data-home-status'))).toEqual(['To do', 'Worked Today', 'Done/Archived']);
        expect(view.host.textContent).toContain('Oct 8, 2026');
        expect(view.host.textContent).toContain('2026-10-08 23:30:00-07:00');
        expect(view.host.textContent).toContain('No due date');
        expect(view.host.querySelector('a')?.getAttribute('role')).toBeNull();
        expect(view.host.querySelector('button[aria-label="Drag task to another status"]')).not.toBeNull();
    } finally { await view.cleanup(); }
});

test('add-task form shares the heading row and submits through the existing Notion refresh', async () => {
    const view = await fixture();
    try {
        const heading = browser.document.querySelector('.oc-home-task-heading');
        // The composer stays compact until activated.
        const opener = heading?.querySelector('form button[type="button"]') as unknown as { click: () => void } | null | undefined;
        await act(async () => opener?.click());
        const form = heading?.querySelector('form');
        const input = form?.querySelector('input');
        expect(heading?.querySelector('h2')?.textContent).toBe('Daily To-Do');
        expect(view.host.querySelectorAll('form')).toHaveLength(1);
        expect(form).not.toBeNull();
        expect(input?.getAttribute('aria-label')).toBe('Add task');
        if (!input || !form) throw new Error('Heading task form missing');
        await act(async () => {
            // Use the native setter so React's controlled input sees the change.
            Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set?.call(input, 'Fixture task');
            input.dispatchEvent(new browser.Event('input', { bubbles: true }));
        });
        await act(async () => form.dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true })));
        expect(view.calls.filter((action) => action === 'create-task')).toHaveLength(1);
        expect(view.calls.filter((action) => action === 'board')).toHaveLength(2);
        expect(input.value).toBe('');
    } finally { await view.cleanup(); }
});

test('keyboard move is optimistic, pending locks duplicate writes, failure restores cards and order', async () => {
    const view = await fixture();
    try {
        await view.move();
        const moved = view.host.querySelector('[data-home-task="https://www.notion.so/fixture-a"]');
        expect(moved?.parentElement?.getAttribute('data-home-status')).toBe('Worked Today');
        expect(moved?.getAttribute('aria-busy')).toBe('true');
        expect(view.calls.filter((action) => action === 'move')).toHaveLength(1);
        expect(view.host.querySelectorAll('[data-home-task]')).toHaveLength(3);
        await view.fail();
        expect(view.host.querySelector('[data-home-task="https://www.notion.so/fixture-a"]')?.parentElement?.getAttribute('data-home-status')).toBe('To do');
        expect([...view.host.querySelectorAll('[data-home-status="To do"] a')].map((item) => item.textContent)).toEqual(['Calendar-day task', 'Timed task']);
        await view.move(); await view.finish();
        expect(view.host.querySelector('[data-home-task="https://www.notion.so/fixture-a"]')?.parentElement?.getAttribute('data-home-status')).toBe('Worked Today');
        expect(view.host.querySelectorAll('[data-home-task]')).toHaveLength(3);
        expect(view.host.querySelector('[aria-busy="true"]')).toBeNull();
        expect(view.calls.filter((action) => action === 'board')).toHaveLength(1);
    } finally { await view.cleanup(); }
});

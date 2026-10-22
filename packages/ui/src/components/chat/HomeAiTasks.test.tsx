import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

test('failed reads preserve setup and drafts, and pre-session failures remain inspectable', async () => {
    const dom = new Window({ url: 'http://localhost' });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    const globals = {
        window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
        Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Node: dom.Node,
        customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
        Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
        MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
        getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
        cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [name, value] of Object.entries(globals)) {
        originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const previousFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => new Promise<Response>(() => {}), previousFetch);
    let rejectBoard: (error: Error) => void = (error) => { throw error; };
    const board = new Promise<never>((_resolve, reject) => { rejectBoard = reject; });
    let reads = 0;
    let available = false;
    const rows: Array<{ url: string; title: string; status: string }> = [];
    const failedRun = { id: 'run_failed', page: 'https://www.notion.so/task', title: 'Failed pickup', phase: 'needs-you', startedAt: 1, content: 'No task prompt was sent. Review the folder and connection.', failure: { stage: 'create', code: 'http_500', message: 'OpenCode or Notion returned HTTP 500.', at: 1 } };
    let creates = 0;
    Object.defineProperty(dom, '__OPENCHAMBER_ELECTRON__', { value: { runtime: 'electron' } });
    Object.defineProperty(dom, '__OPENCHAMBER_DESKTOP__', { value: { invoke: async (command: string, args?: { action?: string; id?: string }) => {
        if (command !== 'desktop_personal_home') throw new Error('Unexpected command');
        if (args?.action === 'ai-status') return {
            config: { board: 'collection://broken', model: '', enabled: false }, runs: available ? [failedRun] : [],
            lastCheckedAt: null, nextCheckAt: null, error: '', provisioning: false,
        };
        if (args?.action === 'ai-projects') return [{ id: 'project', label: 'Research' }];
        if (args?.action === 'ai-details' && args.id === failedRun.id) return { run: failedRun, children: { kind: 'failed', failure: { code: 'http_503', message: 'Child history is unavailable.' } } };
        if (args?.action === 'ai-board') { reads++; return available ? { name: 'AI Tasks', columns: ['Idea'], rows, limited: false } : board; }
        if (args?.action === 'ai-create') { creates++; rows.push({ url: 'https://www.notion.so/task', title: 'Backtest', status: 'Idea' }); return { saved: true }; }
        if (args?.action === 'ai-configure') throw new Error('Use a separate database for AI Tasks, not Daily To-Do.');
        throw new Error('Unexpected action');
    } } });
    const { createRoot } = await import('react-dom/client');
    const { I18nProvider } = await import('@/lib/i18n');
    const { HomeAiTasks } = await import('./HomeAiTasks');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const button = (label: string) => {
        const found = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === label);
        if (!found) throw new Error(`Missing button: ${label}`);
        return found;
    };
    try {
        await act(async () => { root.render(<I18nProvider><HomeAiTasks /></I18nProvider>); });
        expect(reads).toBe(1);
        expect(button('Set up AI Tasks').disabled).toBe(false);
        await act(async () => button('Refresh').click());
        expect(reads).toBe(1);
        expect(button('Set up AI Tasks').disabled).toBe(false);
        expect(button('Refresh').disabled).toBe(true);
        await act(async () => rejectBoard(new Error('Notion is unavailable')));
        expect(container.textContent).toContain('Notion is unavailable');
        expect(button('Set up AI Tasks').disabled).toBe(false);
        await act(async () => button('Set up AI Tasks').click());
        const input = document.querySelector('input[aria-label="Separate Notion database URL"]');
        expect(input instanceof HTMLInputElement && input.required).toBe(false);
        const form = document.querySelector('form');
        if (!form) throw new Error('Missing setup form');
        await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
        expect(document.body.textContent).toContain('Use a separate database');
        expect(button('Save').disabled).toBe(false);
        expect(button('Set up AI Tasks').disabled).toBe(false);
        available = true;
        await act(async () => { root.render(<I18nProvider><HomeAiTasks key="create" /></I18nProvider>); });
        await act(async () => button('Add task').click());
        const title = document.querySelector('input[aria-label="Add task"]');
        if (!(title instanceof HTMLInputElement)) throw new Error('Missing task title input');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (!setter) throw new Error('Missing native input setter');
        await act(async () => { setter.call(title, 'Backtest'); title.dispatchEvent(new Event('input', { bubbles: true })); });
        await act(async () => button('').click());
        expect(creates).toBe(1);
        expect(container.textContent).toContain('Backtest');
        expect(container.textContent).toContain('No folder (All Chats)');
        await act(async () => button('Run details').click());
        expect(document.body.textContent).toContain('No chat linked');
        expect(document.body.textContent).toContain('HTTP 500');
        expect(document.body.textContent).toContain('No task prompt was sent');
        expect(document.body.textContent).toContain('Child history is unavailable');
        expect([...document.querySelectorAll('button')].some(item => item.textContent?.trim() === 'Open chat')).toBe(false);
    } finally {
        await act(async () => root.unmount());
        globalThis.fetch = previousFetch;
        dom.happyDOM.cancelAsync();
        for (const [name, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    }
});

test('board paints before model discovery, refreshes coalesce, and confirmed deletion preserves errors and rejects active cards', async () => {
    const dom = new Window({ url: 'http://localhost' });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    const globals = {
        window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
        Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Node: dom.Node,
        customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
        Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
        MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
        getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
        cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [name, value] of Object.entries(globals)) {
        originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const page = 'https://www.notion.so/idea';
    const working = 'https://www.notion.so/active';
    const rows = [{ url: page, title: 'Legal Pro, Assignment 1', status: 'Idea' }, { url: working, title: 'Active task', status: 'Idea' }];
    const snapshot = { name: 'AI Tasks', columns: ['Idea'], rows, limited: false };
    let reads = 0;
    let deletes = 0;
    let finishRead: () => void = () => {};
    const oldRead = new Promise<typeof snapshot>((resolve) => { finishRead = () => resolve(snapshot); });
    Object.defineProperty(dom, '__OPENCHAMBER_ELECTRON__', { value: { runtime: 'electron' } });
    Object.defineProperty(dom, '__OPENCHAMBER_DESKTOP__', { value: { invoke: async (_command: string, args?: { action?: string; page?: string; confirmed?: boolean }) => {
        if (args?.action === 'ai-status') return { config: { board: 'collection://ai', model: '', enabled: true }, assignments: [],
            runs: [{ id: 'running', page: working, title: 'Active task', phase: 'running', startedAt: 1 }], lastCheckedAt: null, nextCheckAt: null, error: '', provisioning: false };
        if (args?.action === 'ai-projects') return new Promise(() => {});
        if (args?.action === 'ai-board') {
            reads++;
            if (reads === 1) return snapshot;
            if (reads === 2) return oldRead;
            throw new Error('Notion refresh failed');
        }
        if (args?.action === 'ai-delete') {
            expect(args.page).toBe(page); expect(args.confirmed).toBe(true);
            deletes++;
            if (deletes === 1) throw new Error('Notion trash is unavailable');
            return { saved: true };
        }
        throw new Error('Unexpected action');
    } } });
    const { createRoot } = await import('react-dom/client');
    const { I18nProvider } = await import('@/lib/i18n');
    const { HomeAiTasks } = await import('./HomeAiTasks');
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    const button = (label: string) => {
        const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label);
        if (!found) throw new Error(`Missing button: ${label}`);
        return found;
    };
    try {
        await act(async () => root.render(<I18nProvider><HomeAiTasks /></I18nProvider>));
        expect(reads).toBe(1);
        expect(container.textContent).toContain('Legal Pro, Assignment 1');
        expect(container.querySelector<HTMLButtonElement>(`[data-home-task="${working}"] button[aria-label="Delete AI task"]`)?.disabled).toBe(true);
        const trash = container.querySelector<HTMLButtonElement>(`[data-home-task="${page}"] button[aria-label="Delete AI task"]`);
        if (!trash) throw new Error('Trash action missing');
        await act(async () => trash.click());
        expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('You can restore it in Notion. Existing chats are kept.');
        expect(deletes).toBe(0);
        await act(async () => button('Cancel').click());
        expect(deletes).toBe(0);
        await act(async () => button('Refresh').click());
        await act(async () => button('Refresh').click());
        expect(reads).toBe(2);
        await act(async () => trash.click());
        await act(async () => button('Move to Notion trash').click());
        expect(document.body.textContent).toContain('Notion trash is unavailable');
        expect(container.querySelector(`[data-home-task="${page}"]`)).not.toBeNull();
        await act(async () => button('Move to Notion trash').click());
        expect(deletes).toBe(2);
        expect(container.querySelector(`[data-home-task="${page}"]`)).toBeNull();
        await act(async () => finishRead());
        expect(reads).toBe(3);
        expect(container.querySelector(`[data-home-task="${page}"]`)).toBeNull();
        expect(container.querySelector(`[data-home-task="${working}"]`)).not.toBeNull();
        expect(container.textContent).toContain('Notion refresh failed');
    } finally {
        await act(async () => root.unmount()); container.remove(); dom.happyDOM.cancelAsync();
        for (const [name, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    }
});

test('cards hand off to the manager with a per-folder model and refuse unassigned hand-offs', async () => {
    const dom = new Window({ url: 'http://localhost' });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    const globals = {
        window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
        Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Node: dom.Node,
        customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
        Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
        MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
        getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
        cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [name, value] of Object.entries(globals)) {
        originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const assigned = 'https://www.notion.so/assigned';
    const loose = 'https://www.notion.so/loose';
    const moves: string[] = [];
    const saves: string[] = [];
    let saveGate = Promise.resolve();
    Object.defineProperty(dom, '__OPENCHAMBER_ELECTRON__', { value: { runtime: 'electron' } });
    Object.defineProperty(dom, '__OPENCHAMBER_DESKTOP__', { value: { invoke: async (_command: string, args?: { action?: string; page?: string; notes?: string }) => {
        if (args?.action === 'ai-status') return { config: { board: 'collection://ai', model: '', enabled: true }, runs: [],
            assignments: [{ board: 'collection://ai', page: assigned, projectId: 'business', model: { providerID: 'openai', id: 'gpt-sub' } }],
            lastCheckedAt: null, nextCheckAt: null, error: '', provisioning: false };
        if (args?.action === 'ai-projects') return [{ id: 'business', label: 'Business Launch', models: [
            { providerID: 'openrouter', id: 'free-model', name: 'Free Model', default: true },
            { providerID: 'openai', id: 'gpt-sub', name: 'GPT Sub', default: false },
        ] }];
        if (args?.action === 'ai-board') return { name: 'AI Tasks', columns: ['Idea', 'Ready for AI'], rows: [
            { url: assigned, title: 'Compare launch options', status: 'Idea', due: null },
            { url: loose, title: 'No folder yet', status: 'Idea', due: null },
        ], limited: false };
        if (args?.action === 'ai-move') { moves.push(args.page ?? ''); return { saved: true }; }
        if (args?.action === 'ai-notes') return { notes: '', editable: true };
        if (args?.action === 'ai-save-notes') { saves.push(args.notes ?? ''); await saveGate; return { saved: true }; }
        throw new Error('Unexpected action');
    } } });
    const { createRoot } = await import('react-dom/client');
    const { I18nProvider } = await import('@/lib/i18n');
    const { HomeAiTasks } = await import('./HomeAiTasks');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () => { root.render(<I18nProvider><HomeAiTasks /></I18nProvider>); });
        expect([...container.querySelectorAll('h3')].map(item => item.textContent)).toEqual(['Idea2', 'Send to manager0']);
        const cards = [...container.querySelectorAll('[data-home-task]')];
        const assignedCard = cards.find(item => item.getAttribute('data-home-task') === assigned);
        expect(assignedCard?.textContent).toContain('Business Launch');
        expect(assignedCard?.textContent).toContain('ChatGPT · GPT Sub');
        const looseCard = cards.find(item => item.getAttribute('data-home-task') === loose);
        expect(looseCard?.textContent).toContain('No folder (All Chats)');
        expect(looseCard?.textContent).not.toContain('OpenRouter');
        const move = looseCard?.querySelector('button[aria-label="Move task"]');
        if (!move) throw new Error('Move control missing');
        await act(async () => move.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
        const option = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === 'Send to manager');
        if (!option) throw new Error('Send to manager option missing');
        await act(async () => option.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
        expect(moves).toEqual([]);
        expect(container.textContent).toContain('Choose a project folder before sending this card to the manager.');
        // An assigned card with no notes asks for its brief instead of sending only a title.
        const sendAssigned = assignedCard?.querySelector('button[aria-label="Move task"]');
        if (!sendAssigned) throw new Error('Move control missing');
        await act(async () => sendAssigned.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
        const handOff = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === 'Send to manager');
        if (!handOff) throw new Error('Send to manager option missing');
        await act(async () => handOff.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
        expect(moves).toEqual([]);
        expect(document.body.textContent).toContain('This card has no notes yet.');
        const titleOnly = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === 'Send title only');
        if (!titleOnly) throw new Error('Send title only missing');
        await act(async () => titleOnly.click());
        expect(moves).toEqual([assigned]);
        const send = [...container.querySelectorAll<HTMLButtonElement>(`[data-home-task="${assigned}"] button`)].find(item => item.textContent?.trim() === 'Send');
        if (!send) throw new Error('Send button missing');
        await act(async () => send.click());
        const textarea = document.querySelector('textarea');
        if (!textarea) throw new Error('Notes editor missing');
        expect(textarea.placeholder).toContain('https://... Assignment 1');
        expect(textarea.placeholder).toContain('Legal Pro in the Villanova Law Dashboard, Assignment 1');
        expect(document.body.textContent).toContain('References provide context, not permission to act.');
        const setter = Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, 'value')?.set;
        if (!setter) throw new Error('Textarea setter missing');
        const brief = 'Compare three law practice vendors. Verify pricing and deliver a recommendation.';
        await act(async () => { setter.call(textarea, brief); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
        const saveSend = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === 'Save and send to manager');
        if (!saveSend) throw new Error('Save and send missing');
        let rejectSave: (error: Error) => void = (error) => { throw error; };
        saveGate = new Promise<void>((_resolve, reject) => { rejectSave = reject; });
        await act(async () => saveSend.click());
        expect(saves).toEqual([brief]);
        expect(moves).toEqual([assigned]);
        await act(async () => rejectSave(new Error('Notion reported content warnings.')));
        expect(document.querySelector('textarea')?.value).toBe(brief);
        expect(document.body.textContent).toContain('Notion reported content warnings.');
        expect(moves).toEqual([assigned]);
        let confirmSave: () => void = () => {};
        saveGate = new Promise<void>((resolve) => { confirmSave = resolve; });
        await act(async () => saveSend.click());
        expect(moves).toEqual([assigned]);
        await act(async () => confirmSave());
        expect(moves).toEqual([assigned, assigned]);
        expect(document.querySelector('textarea')).toBeNull();
    } finally {
        await act(async () => root.unmount());
        dom.happyDOM.cancelAsync();
        for (const [name, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    }
});

for (const { remembered, expected } of [
    { remembered: null, expected: 'free-model' },
    { remembered: 'preferred', expected: 'preferred' },
    { remembered: 'removed', expected: 'free-model' },
]) test(`folderless handoff sends a concrete approved model (${remembered ?? 'default'})`, async () => {
    const dom = new Window({ url: 'http://localhost' });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    const globals = {
        window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
        Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Node: dom.Node,
        customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
        Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
        MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
        getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
        cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [name, value] of Object.entries(globals)) {
        originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const loose = 'https://www.notion.so/loose';
    const assigns: Array<{ page?: string; projectId?: string; model?: { providerID: string; id: string } }> = [];
    const moves: string[] = [];
    if (remembered) dom.localStorage.setItem('open-carter:ai-task-model:v1:openchamber:all-chats', JSON.stringify({ providerID: 'openrouter', id: remembered }));
    Object.defineProperty(dom, '__OPENCHAMBER_ELECTRON__', { value: { runtime: 'electron' } });
    Object.defineProperty(dom, '__OPENCHAMBER_DESKTOP__', { value: { invoke: async (_command: string, args?: { action?: string; page?: string; projectId?: string; model?: { providerID: string; id: string } }) => {
        if (args?.action === 'ai-status') return { config: { board: 'collection://ai', model: '', enabled: true }, runs: [], assignments: [],
            lastCheckedAt: null, nextCheckAt: null, error: '', provisioning: false };
        if (args?.action === 'ai-projects') return [
            { id: 'openchamber:all-chats', label: 'No folder (All Chats)', models: [{ providerID: 'openrouter', id: 'free-model', name: 'Free Model', default: true }, { providerID: 'openrouter', id: 'preferred', name: 'Preferred', default: false }] },
            { id: 'legal', label: 'Legal', models: [] },
        ];
        if (args?.action === 'ai-board') return { name: 'AI Tasks', columns: ['Idea', 'Ready for AI'], rows: [{ url: loose, title: 'Quick idea', status: 'Idea', due: null }], limited: false };
        if (args?.action === 'ai-assign') { assigns.push({ page: args.page, projectId: args.projectId, model: args.model }); return { saved: true }; }
        if (args?.action === 'ai-move') { moves.push(args.page ?? ''); return { saved: true }; }
        if (args?.action === 'ai-notes') return { notes: 'Full brief', editable: true };
        throw new Error('Unexpected action');
    } } });
    const { createRoot } = await import('react-dom/client');
    const { I18nProvider } = await import('@/lib/i18n');
    const { HomeAiTasks } = await import('./HomeAiTasks');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () => { root.render(<I18nProvider><HomeAiTasks /></I18nProvider>); });
        const move = container.querySelector(`[data-home-task="${loose}"] button[aria-label="Move task"]`);
        if (!move) throw new Error('Move control missing');
        await act(async () => move.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
        const option = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === 'Send to manager');
        if (!option) throw new Error('Send to manager option missing');
        await act(async () => option.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
        expect(assigns).toEqual([{ page: loose, projectId: 'openchamber:all-chats', model: { providerID: 'openrouter', id: expected } }]);
        expect(moves).toEqual([loose]);
        expect(container.textContent).not.toContain('Choose a project folder before sending');
    } finally {
        await act(async () => root.unmount());
        dom.happyDOM.cancelAsync();
        for (const [name, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    }
});

for (const startingAssigned of [true, false]) test(`folder changes retain acknowledged models through delayed/failed refresh (${startingAssigned}) and unavailable choices block handoff`, async () => {
    const dom = new Window({ url: 'http://localhost' });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    const globals = {
        window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
        Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Node: dom.Node,
        customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
        Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
        MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
        getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
        cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [name, value] of Object.entries(globals)) {
        originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const page = 'https://www.notion.so/assigned';
    const selected = { providerID: 'openai', id: 'chosen' };
    const fallback = { providerID: 'openrouter', id: 'free', name: 'Free Model', default: true };
    let approved = true;
    let emptyCatalog = false;
    let projectId = 'source';
    let assigned = startingAssigned;
    let holdStatus = false;
    let rejectStatus: (error: Error) => void = () => { throw new Error('Status is not pending'); };
    const statusWait = new Promise<never>((_resolve, reject) => { rejectStatus = reject; });
    const assigns: Array<{ projectId?: string; model?: { providerID: string; id: string } }> = [];
    const writes: string[] = [];
    dom.localStorage.setItem('open-carter:ai-task-model:v1:target', JSON.stringify(startingAssigned ? fallback : selected));
    Object.defineProperty(dom, '__OPENCHAMBER_ELECTRON__', { value: { runtime: 'electron' } });
    Object.defineProperty(dom, '__OPENCHAMBER_DESKTOP__', { value: { invoke: async (_command: string, args?: { action?: string; projectId?: string; model?: { providerID: string; id: string } }) => {
        if (args?.action === 'ai-status') return holdStatus ? statusWait : { config: { board: 'collection://ai', model: '', enabled: true }, runs: [],
            assignments: assigned ? [{ board: 'collection://ai', page, projectId, model: selected }] : [],
            lastCheckedAt: null, nextCheckAt: null, error: '', provisioning: false };
        if (args?.action === 'ai-projects') return ['source', 'target'].map(id => ({ id, label: id, models: emptyCatalog ? [] : approved ? [fallback, { ...selected, name: 'Chosen', default: false }] : [fallback] }));
        if (args?.action === 'ai-board') return { name: 'AI Tasks', columns: ['Idea', 'Ready for AI'], rows: [{ url: page, title: 'Keep my model', status: 'Idea' }], limited: false };
        if (args?.action === 'ai-assign') { assigns.push({ projectId: args.projectId, model: args.model }); projectId = args.projectId ?? projectId; assigned = true; holdStatus = true; return { saved: true }; }
        if (args?.action === 'ai-notes') return { notes: '', editable: true };
        if (args?.action === 'ai-move' || args?.action === 'ai-save-notes') { writes.push(args.action); return { saved: true }; }
        throw new Error('Unexpected action');
    } } });
    const { createRoot } = await import('react-dom/client');
    const { I18nProvider } = await import('@/lib/i18n');
    const { HomeAiTasks } = await import('./HomeAiTasks');
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    const button = (label: string) => {
        const found = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === label);
        if (!found) throw new Error(`Missing button: ${label}`);
        return found;
    };
    try {
        await act(async () => root.render(<I18nProvider><HomeAiTasks /></I18nProvider>));
        const folder = container.querySelector('[aria-label="Project folder"]');
        if (!folder) throw new Error('Folder picker missing');
        await act(async () => folder.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
        const target = [...document.querySelectorAll('[role="option"]')].find(item => item.textContent === 'target');
        if (!target) throw new Error('Target folder missing');
        await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
        await act(async () => target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
        expect(assigns).toEqual([{ projectId: 'target', model: selected }]);
        expect(container.querySelector('[aria-label="Model"]')?.textContent).toContain('Chosen');
        await act(async () => button('Send').click());
        expect(assigns).toHaveLength(1);
        await act(async () => rejectStatus(new Error('Status refresh unavailable')));
        await act(async () => button('Send').click());
        expect(assigns).toHaveLength(1);
        const textarea = document.querySelector('textarea');
        const setter = Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, 'value')?.set;
        if (!textarea || !setter) throw new Error('Notes editor missing');
        await act(async () => { setter.call(textarea, 'Keep this brief'); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
        approved = false;
        holdStatus = false;
        await act(async () => button('Refresh').click());
        const model = container.querySelector('[aria-label="Model"]');
        expect(model?.textContent).toContain('openai/chosen');
        expect(model?.textContent).toContain('Model metadata unavailable.');
        expect(model?.textContent).not.toContain('Folder default');
        expect(model?.getAttribute('aria-invalid')).toBe('true');
        await act(async () => button('Save and send to manager').click());
        expect(writes).toEqual([]);
        expect(assigns).toHaveLength(1);
        expect(document.querySelector('textarea')?.value).toBe('Keep this brief');
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Model metadata unavailable.');
        emptyCatalog = true;
        await act(async () => button('Refresh').click());
        expect(container.querySelector('[aria-label="Model"]')?.textContent).toContain('openai/chosen');
        expect(container.querySelector('[aria-label="Model"]')?.getAttribute('disabled')).not.toBeNull();
        // Direct handoff must fail too, without disturbing the open notes draft.
        await act(async () => button('Send').click());
        expect(writes).toEqual([]);
        expect(document.querySelector('textarea')?.value).toBe('Keep this brief');
        // Acknowledgements belong to one runtime, not to a matching page URL
        // returned by a different host.
        emptyCatalog = false; approved = true;
        await act(async () => button('Refresh').click());
        const currentFolder = container.querySelector('[aria-label="Project folder"]');
        if (!currentFolder) throw new Error('Folder picker missing');
        await act(async () => currentFolder.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
        const source = [...document.querySelectorAll('[role="option"]')].find(item => item.textContent === 'source');
        if (!source) throw new Error('Source folder missing');
        await act(async () => source.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
        await act(async () => source.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
        expect(assigns).toHaveLength(2);
        expect(container.querySelector('[aria-label="Project folder"]')?.textContent).toContain('source');
        holdStatus = false; projectId = 'target';
        Object.defineProperty(dom, '__OPENCHAMBER_API_BASE_URL__', { value: 'https://other-runtime.example', configurable: true });
        await act(async () => window.dispatchEvent(new CustomEvent('openchamber:runtime-endpoint-changed')));
        expect(container.querySelector('[aria-label="Project folder"]')?.textContent).toContain('target');
        expect(document.querySelector('textarea')).toBeNull();
    } finally {
        await act(async () => root.unmount()); container.remove(); dom.happyDOM.cancelAsync();
        for (const [name, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    }
});

test('the Send button hands a card off in one click and finished work starts folded', async () => {
    const dom = new Window({ url: 'http://localhost' });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    const globals = {
        window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
        Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Node: dom.Node,
        customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
        Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
        MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
        getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
        cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [name, value] of Object.entries(globals)) {
        originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const loose = 'https://www.notion.so/loose';
    const assigns: Array<{ page?: string; projectId?: string }> = [];
    const moves: string[] = [];
    Object.defineProperty(dom, '__OPENCHAMBER_ELECTRON__', { value: { runtime: 'electron' } });
    Object.defineProperty(dom, '__OPENCHAMBER_DESKTOP__', { value: { invoke: async (_command: string, args?: { action?: string; page?: string; projectId?: string }) => {
        if (args?.action === 'ai-status') return { config: { board: 'collection://ai', model: '', enabled: true }, runs: [], assignments: [],
            lastCheckedAt: null, nextCheckAt: null, error: '', provisioning: false };
        if (args?.action === 'ai-projects') return [
            { id: 'openchamber:all-chats', label: 'No folder (All Chats)', models: [{ providerID: 'openrouter', id: 'free-model', name: 'Free Model', default: true }] },
            { id: 'legal', label: 'Legal', models: [] },
        ];
        if (args?.action === 'ai-board') return { name: 'AI Tasks', columns: ['Idea', 'Ready for AI', 'Done'], rows: [{ url: loose, title: 'Quick idea', status: 'Idea', due: null }, { url: 'https://www.notion.so/old', title: 'Finished earlier', status: 'Done', due: null }], limited: false };
        if (args?.action === 'ai-assign') { assigns.push({ page: args.page, projectId: args.projectId }); return { saved: true }; }
        if (args?.action === 'ai-move') { moves.push(args.page ?? ''); return { saved: true }; }
        if (args?.action === 'ai-notes') return { notes: 'Full brief', editable: true };
        throw new Error('Unexpected action');
    } } });
    const { createRoot } = await import('react-dom/client');
    const { I18nProvider } = await import('@/lib/i18n');
    const { HomeAiTasks } = await import('./HomeAiTasks');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () => { root.render(<I18nProvider><HomeAiTasks /></I18nProvider>); });
        // Done is folded: its count shows, its cards do not.
        expect([...container.querySelectorAll('h3')].map(item => item.textContent)).toEqual(['Idea1', 'Send to manager0', 'Done1']);
        expect(container.textContent).not.toContain('Finished earlier');
        const send = [...container.querySelectorAll<HTMLButtonElement>(`[data-home-task="${loose}"] button`)].find(item => item.textContent?.trim() === 'Send');
        if (!send) throw new Error('Send button missing');
        await act(async () => send.click());
        expect(assigns).toEqual([{ page: loose, projectId: 'openchamber:all-chats' }]);
        expect(moves).toEqual([loose]);
        const done = [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find(item => item.textContent === 'Done');
        if (!done) throw new Error('Done group toggle missing');
        await act(async () => done.click());
        expect(container.textContent).toContain('Finished earlier');
    } finally {
        await act(async () => root.unmount());
        dom.happyDOM.cancelAsync();
        for (const [name, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    }
});

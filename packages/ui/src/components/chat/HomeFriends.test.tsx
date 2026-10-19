import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
    window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
    HTMLElement: browser.HTMLElement, HTMLInputElement: browser.HTMLInputElement, Element: browser.Element, Node: browser.Node, Event: browser.Event, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent,
    ResizeObserver: browser.ResizeObserver, MutationObserver: browser.MutationObserver, requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
})) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
// Imported stores probe the runtime on load; keep those reads pending instead of hitting the network.
const previousFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => new Promise<Response>(() => {}), previousFetch);
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { HomeFriendCards, HomeFriendsHeader } = await import('./HomeFriends');
const { HomeFriendCustomize } = await import('./HomeFriendCustomize');
const { readFriendProfiles, saveFriendProfile, defaultFriendAppearance, FRIEND_BODIES, FRIEND_COLORS } = await import('@/lib/friends');
type Cards = React.ComponentProps<typeof HomeFriendCards>['friends'];
type Target = NonNullable<React.ComponentProps<typeof HomeFriendCustomize>['target']>;

afterAll(async () => {
    globalThis.fetch = previousFetch;
    await browser.happyDOM.close();
    for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
});

async function mount(node: React.ReactNode) {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<I18nProvider>{node}</I18nProvider>));
    return {
        host,
        rerender: (next: React.ReactNode) => act(async () => root.render(<I18nProvider>{next}</I18nProvider>)),
        cleanup: async () => { await act(async () => root.unmount()); host.remove(); },
    };
}
const click = (element: ReturnType<typeof browser.document.querySelector> | undefined) => act(async () => {
    if (!element) throw new Error('Missing element');
    element.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, cancelable: true }));
});
const button = (label: string) => browser.document.querySelector(`button[aria-label="${label}"]`);

const cards: Cards = [
    { agent: 'build', name: 'Pip', role: 'Build', appearance: defaultFriendAppearance('build'), status: { kind: 'working', text: 'Working now' }, specialist: false },
    { agent: 'explore', name: 'Sage', role: 'Explore', appearance: { body: 'ghost', color: 'keyword' }, status: { kind: 'about', text: 'Reads code quickly.' }, specialist: true },
];

test('friend cards show face, name, role and status and route clicks to the right action', async () => {
    const calls: string[] = [];
    const view = await mount(<HomeFriendCards friends={cards} busyAgent=""
        onOpen={agent => calls.push(`open:${agent}`)} onNew={agent => calls.push(`new:${agent}`)}
        onCustomize={agent => calls.push(`customize:${agent}`)} onDetails={agent => calls.push(`details:${agent}`)} />);
    try {
        const items = [...view.host.querySelectorAll('li[data-friend]')];
        expect(items.map(item => item.getAttribute('data-friend'))).toEqual(['build', 'explore']);
        const pip = items[0];
        expect(pip.querySelector('.oc-friend-card-name')?.textContent).toBe('Pip');
        expect(pip.querySelector('.oc-friend-card-role')?.textContent).toBe('Build');
        expect(pip.querySelector('.oc-friend-card-status')?.getAttribute('data-kind')).toBe('working');
        expect(pip.querySelector('svg[data-body]')?.getAttribute('data-color')).toBe('success');
        expect(items[1].querySelector('svg')?.getAttribute('data-body')).toBe('ghost');
        const main = button('Continue conversation with Pip');
        expect(main?.getAttribute('aria-describedby')).toBe('friend-status-build');
        await click(main);
        await click(button('Pip: New conversation'));
        // A specialist cannot be chatted with directly; its card opens details instead.
        await click(button('Open details for Sage'));
        expect(button('Sage: New conversation')).toBeNull();
        expect(button('More for Sage')).not.toBeNull();
        expect(calls).toEqual(['open:build', 'new:build', 'details:explore']);
        await view.rerender(<HomeFriendCards friends={cards} busyAgent="build" onOpen={() => {}} onNew={() => {}} onCustomize={() => {}} onDetails={() => {}} />);
        expect(button('Continue conversation with Pip')?.hasAttribute('disabled')).toBe(true);
        expect(view.host.querySelector('li[data-friend="build"]')?.getAttribute('data-busy')).toBe('true');
        expect(view.host.querySelector('li[data-friend="build"] .oc-friend-card-status')?.textContent).toContain('Opening');
    } finally { await view.cleanup(); }
});

test('the header keeps folder scope as one compact selector beside an icon-only refresh', async () => {
    let refreshed = 0;
    const projects = [{ id: 'carter', path: '/Users/carter/carter', label: 'carter' }, { id: 'legal', path: '/Users/carter/legal' }];
    const view = await mount(<HomeFriendsHeader projects={projects} project={projects[1]} loading={false} busy={false} onChooseFolder={() => {}} onRefresh={() => { refreshed++; }} />);
    try {
        expect(view.host.querySelector('h2')?.textContent).toBe('Friends');
        const folder = view.host.querySelector('[aria-label="Friends folder"]');
        expect(folder?.textContent).toContain('legal');
        await click(button('Refresh friends'));
        expect(refreshed).toBe(1);
        await view.rerender(<HomeFriendsHeader projects={[]} project={undefined} loading={false} busy={false} onChooseFolder={() => {}} onRefresh={() => {}} />);
        expect(view.host.querySelector('[aria-label="Friends folder"]')).toBeNull();
        expect(button('Refresh friends')).toBeNull();
    } finally { await view.cleanup(); }
});

function storage() {
    const values = new Map<string, string>();
    return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
const target: Target = { agent: 'plan', role: 'Plan', name: 'Plan', appearance: defaultFriendAppearance('plan'), origin: null };

test('customize saves the chosen look and trimmed name through the revision-checked store', async () => {
    const store = storage();
    let profiles = readFriendProfiles(store, 'local');
    let closed = 0;
    const save = (agent: string, draft: Parameters<typeof saveFriendProfile>[3]) => { profiles = saveFriendProfile(store, 'local', agent, draft, profiles.revision); };
    const view = await mount(<HomeFriendCustomize target={target} onClose={() => { closed++; }} onSave={save} />);
    try {
        const dialog = browser.document.querySelector('[data-testid="friend-customize"]');
        if (!dialog) throw new Error('Customize dialog did not open');
        expect(dialog.querySelectorAll('button[aria-label^="Shape "]')).toHaveLength(FRIEND_BODIES.length);
        expect(dialog.querySelectorAll('button[aria-label^="Color "]')).toHaveLength(FRIEND_COLORS.length);
        const body = FRIEND_BODIES.indexOf('flower') + 1;
        const color = FRIEND_COLORS.indexOf('string') + 1;
        await click(button(`Shape ${body}`));
        await click(button(`Color ${color}`));
        expect(button(`Shape ${body}`)?.getAttribute('aria-pressed')).toBe('true');
        expect(button(`Color ${color}`)?.getAttribute('aria-pressed')).toBe('true');
        const preview = dialog.querySelector('svg[role="img"]');
        expect(preview?.getAttribute('data-body')).toBe('flower');
        expect(preview?.getAttribute('data-color')).toBe('string');
        const input = dialog.querySelector('input');
        if (!(input instanceof browser.HTMLInputElement)) throw new Error('Missing name field');
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
            setter?.call(input, '  Atlas  ');
            input.dispatchEvent(new browser.Event('input', { bubbles: true }));
        });
        expect(dialog.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toBe('Avatar for Atlas');
        await click([...dialog.querySelectorAll('button[type="submit"]')].at(0));
        expect(closed).toBe(1);
        expect(readFriendProfiles(store, 'local').friends).toEqual([{ agent: 'plan', name: 'Atlas', body: 'flower', color: 'string' }]);
    } finally { await view.cleanup(); }
});

test('a save conflict keeps the dialog and the draft and tells the user why', async () => {
    const store = storage();
    const stale = readFriendProfiles(store, 'local');
    // Another window saves first, moving the revision past the one this dialog read.
    saveFriendProfile(store, 'local', 'build', { name: 'Bolt', body: 'blob', color: 'primary' }, 0);
    let closed = 0;
    const view = await mount(<HomeFriendCustomize target={target} onClose={() => { closed++; }}
        onSave={(agent, draft) => { saveFriendProfile(store, 'local', agent, draft, stale.revision); }} />);
    try {
        await click(button('Shape 1'));
        await click([...browser.document.querySelectorAll('[data-testid="friend-customize"] button[type="submit"]')].at(0));
        expect(closed).toBe(0);
        expect(browser.document.querySelector('[data-testid="friend-customize"] [role="alert"]')?.textContent).toContain('another window');
        expect(button('Shape 1')?.getAttribute('aria-pressed')).toBe('true');
        expect(readFriendProfiles(store, 'local').friends.map(item => item.agent)).toEqual(['build']);
    } finally { await view.cleanup(); }
});

test('Escape closes the customize panel without saving', async () => {
    const store = storage();
    let closed = 0;
    const view = await mount(<HomeFriendCustomize target={target} onClose={() => { closed++; }} onSave={() => { throw new Error('must not save'); }} />);
    try {
        const input = browser.document.querySelector('[data-testid="friend-customize"] input');
        await act(async () => { input?.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
        expect(closed).toBe(1);
        expect(store.values.size).toBe(0);
    } finally { await view.cleanup(); }
});

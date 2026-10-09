import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
    window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
    HTMLElement: browser.HTMLElement, Element: browser.Element, ResizeObserver: browser.ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true,
})) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
}
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { HomeWidgetLayout } = await import('./HomeWidgetLayout');
const { defaultHomeLayout, restoreHomeLayout } = await import('./home-widget-layout');
const key = 'openchamber.personalHome.layout.v2';

afterAll(async () => {
    await browser.happyDOM.close();
    for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
});

async function fixture() {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const widgets = {
        working: { label: 'Working', content: <p>Working content</p> },
        recent: { label: 'Recent', content: <p>Recent content</p> },
        tasks: { label: 'Tasks', content: <p>Tasks content</p> },
        calendar: { label: 'Calendar', content: <p>Calendar content</p> },
        habits: { label: 'Habits', content: <p>Habits content</p> },
        projects: { label: 'Projects', content: <p>Projects content</p> },
        shortcuts: { label: 'Shortcuts', content: <p>Shortcuts content</p> },
    };
    await act(async () => root.render(<I18nProvider><HomeWidgetLayout widgets={widgets} /></I18nProvider>));
    const divider = browser.document.querySelector('[role="separator"]');
    if (!divider) throw new Error('Missing column divider');
    return {
        host, divider,
        key: (name: string, shiftKey = false) => act(async () => { divider.dispatchEvent(new browser.KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true })); }),
        cleanup: async () => { await act(async () => root.unmount()); host.remove(); },
    };
}

test('focused divider resizes with keyboard, persists fractional preferences and survives remount', async () => {
    browser.localStorage.clear();
    browser.localStorage.setItem(key, JSON.stringify(defaultHomeLayout()));
    const view = await fixture();
    try {
        expect(view.divider.getAttribute('aria-orientation')).toBe('vertical');
        expect(view.divider.getAttribute('aria-label')).toBe('Resize Home columns');
        await view.key('ArrowRight');
        expect(view.divider.getAttribute('aria-valuenow')).toBe('52');
        await view.key('ArrowRight', true);
        expect(view.divider.getAttribute('aria-valuenow')).toBe('62');
        await view.key('ArrowLeft');
        expect(restoreHomeLayout(browser.localStorage.getItem(key), null)[0].width).toBe(60);
        await view.key('End');
        expect(view.divider.getAttribute('aria-valuenow')).toBe('80');
        await view.key('ArrowRight');
        expect(view.divider.getAttribute('aria-valuenow')).toBe('80');
        await view.key('Home');
        expect(view.divider.getAttribute('aria-valuenow')).toBe('20');
    } finally { await view.cleanup(); }
    const reloaded = await fixture();
    try { expect(reloaded.divider.getAttribute('aria-valuenow')).toBe('20'); }
    finally { await reloaded.cleanup(); }
});

test('storage failure keeps the resized layout usable, reports failure and can retry', async () => {
    browser.localStorage.clear();
    const view = await fixture();
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    if (!original) throw new Error('Storage fixture missing');
    try {
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('Storage unavailable'); } });
        await view.key('ArrowRight');
        expect(view.divider.getAttribute('aria-valuenow')).toBe('52');
        expect(view.host.querySelector('[role="alert"]')).not.toBeNull();
        Object.defineProperty(globalThis, 'localStorage', original);
        await view.key('ArrowRight');
        expect(view.divider.getAttribute('aria-valuenow')).toBe('54');
        expect(view.host.querySelector('[role="alert"]')).toBeNull();
    } finally { Object.defineProperty(globalThis, 'localStorage', original); await view.cleanup(); }
});

test('pointer resizing previews continuously and only persists the released proportion', async () => {
    browser.localStorage.clear();
    browser.localStorage.setItem(key, JSON.stringify(defaultHomeLayout()));
    const originalObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
    if (!originalObserver) throw new Error('Resize observer fixture missing');
    class MeasuredResizeObserver implements ResizeObserver {
        constructor(private callback: ResizeObserverCallback) {}
        observe(target: Element) {
            this.callback([{
                target, contentRect: { x: 0, y: 0, width: 1016, height: 600, top: 0, right: 1016, bottom: 600, left: 0, toJSON: () => ({}) },
                borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [],
            }], this);
        }
        unobserve() {}
        disconnect() {}
    }
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: MeasuredResizeObserver });
    const view = await fixture();
    try {
        const columns = view.divider.parentElement;
        if (!(columns instanceof browser.HTMLElement)) throw new Error('Missing column container');
        Object.defineProperty(columns, 'getBoundingClientRect', { value: () => new browser.DOMRect(0, 0, 1016, 600) });
        Object.defineProperty(view.divider, 'setPointerCapture', { value: () => {} });
        Object.defineProperty(view.divider, 'releasePointerCapture', { value: () => {} });
        const pointer = (type: string, clientX: number) => act(async () => {
            view.divider.dispatchEvent(new browser.PointerEvent(type, { pointerId: 1, button: 0, clientX, bubbles: true, cancelable: true }));
        });
        await pointer('pointerdown', 508);
        await pointer('pointermove', 621.7);
        expect(Math.abs(Number.parseFloat(columns.style.getPropertyValue('--home-left-width')) - 61.37) < 0.000001).toBe(true);
        expect(restoreHomeLayout(browser.localStorage.getItem(key), null)[0].width).toBe(50);
        await pointer('pointermove', 622.8);
        expect(Math.abs(Number.parseFloat(columns.style.getPropertyValue('--home-left-width')) - 61.48) < 0.000001).toBe(true);
        await pointer('pointerup', 622.8);
        expect(Math.abs(restoreHomeLayout(browser.localStorage.getItem(key), null)[0].width - 61.48) < 0.000001).toBe(true);
        expect(view.divider.getAttribute('data-resizing')).toBeNull();
    } finally {
        await view.cleanup();
        Object.defineProperty(globalThis, 'ResizeObserver', originalObserver);
    }
});

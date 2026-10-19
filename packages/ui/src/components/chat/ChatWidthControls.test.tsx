import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const dom = new Window();
const names = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'PointerEvent', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'];
const descriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let resize: ResizeObserverCallback | undefined;
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
Object.assign(globalThis, {
    window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
    PointerEvent: dom.PointerEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
    getComputedStyle: dom.getComputedStyle.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    ResizeObserver: class {
        constructor(callback: ResizeObserverCallback) { resize = callback; }
        observe() {} unobserve() {} disconnect() { resize = undefined; }
    },
});
const { I18nProvider } = await import('@/lib/i18n');
const { useUIStore } = await import('@/stores/useUIStore');
const { ChatWidthControls } = await import('./ChatWidthControls');

describe('chat column resizing', () => {
    let host: HTMLDivElement;
    let root: Root;
    let available = 1400;
    let transcriptRenders = 0;
    const Transcript = () => { transcriptRenders++; return <div className="chat-message-column">Synthetic transcript</div>; };
    const initial = useUIStore.getState();
    const render = async (enabled = true) => {
        await act(async () => root.render(<I18nProvider><ChatWidthControls enabled={enabled} /><Transcript /></I18nProvider>));
    };
    const handle = (edge = 'end') => {
        const node = host.querySelector<HTMLDivElement>(`[data-edge="${edge}"]`);
        if (!node) throw new Error('Missing resize edge');
        return node;
    };
    const flush = async () => {
        await act(async () => {
            const pending = frames; frames = new Map();
            pending.forEach(callback => callback(0));
        });
    };
    const pointer = async (node: HTMLElement, type: string, clientX: number, pointerId = 1) => {
        await act(async () => node.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, isPrimary: true, pointerId, clientX })));
    };
    const key = async (node: HTMLElement, type: string, name: string, shiftKey = false) => {
        await act(async () => node.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: name, shiftKey })));
    };

    beforeEach(async () => {
        useUIStore.setState({ chatColumnWidth: null, wideChatLayoutEnabled: false });
        available = 1400; transcriptRenders = 0;
        document.documentElement.style.fontSize = '16px';
        host = document.createElement('div');
        Object.defineProperty(host, 'clientWidth', { get: () => available });
        document.body.append(host); root = createRoot(host);
        await render();
        for (const node of host.querySelectorAll<HTMLDivElement>('[data-edge]')) {
            let captured: number | undefined;
            Object.defineProperties(node, {
                setPointerCapture: { value: (id: number) => { captured = id; } },
                hasPointerCapture: { value: (id: number) => captured === id },
                releasePointerCapture: { value: () => { captured = undefined; } },
            });
        }
    });
    afterEach(async () => {
        await act(async () => root.unmount()); host.remove(); frames.clear();
        useUIStore.setState(initial, true);
    });
    afterAll(() => {
        dom.happyDOM.close();
        for (const [name, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    });

    test('both edges resize symmetrically without store writes or transcript renders during preview', async () => {
        let commits = 0;
        const unsubscribe = useUIStore.subscribe((state, previous) => { if (state.chatColumnWidth !== previous.chatColumnWidth) commits++; });
        try {
            for (const [edge, start, end] of [['end', 100, 200], ['start', 200, 100]] as const) {
                await act(async () => useUIStore.getState().setChatColumnWidth(null)); commits = 0;
                const renders = transcriptRenders;
                await pointer(handle(edge), 'pointerdown', start);
                expect(handle(edge).hasAttribute('data-resizing')).toBe(true);
                expect(handle(edge === 'end' ? 'start' : 'end').hasAttribute('data-resizing')).toBe(false);
                await pointer(handle(edge), 'pointermove', end); await flush();
                expect(host.style.getPropertyValue('--oc-chat-width')).toBe('968px');
                expect(commits).toBe(0); expect(transcriptRenders).toBe(renders);
                await pointer(handle(edge), 'pointerup', end);
                expect(useUIStore.getState().chatColumnWidth).toBe(968); expect(commits).toBe(1);
                expect(handle(edge).hasPointerCapture(1)).toBe(false);
                expect(handle(edge).hasAttribute('data-resizing')).toBe(false);
            }
        } finally { unsubscribe(); }
    });
    test('Escape, pointer cancellation and lost capture restore the saved width and clear frames', async () => {
        await act(async () => useUIStore.getState().setChatColumnWidth(1100));
        for (const ending of ['Escape', 'pointercancel', 'lostpointercapture']) {
            await pointer(handle(), 'pointerdown', 100);
            await pointer(handle(), 'pointermove', 150); await flush();
            if (ending === 'Escape') await key(handle(), 'keydown', ending);
            else await pointer(handle(), ending, 150);
            await flush();
            expect(host.style.getPropertyValue('--oc-chat-width')).toBe('1100px');
            expect(useUIStore.getState().chatColumnWidth).toBe(1100);
            expect(host.hasAttribute('data-chat-resizing')).toBe(false);
            expect(handle().hasAttribute('data-resizing')).toBe(false);
            expect(frames.size).toBe(0);
        }
    });
    test('keyboard steps, limits, reset and RTL match the physical edges', async () => {
        await key(handle(), 'keydown', 'ArrowRight', true); await key(handle(), 'keyup', 'ArrowRight');
        expect(useUIStore.getState().chatColumnWidth).toBe(848);
        await key(handle(), 'keydown', 'End'); await key(handle(), 'keyup', 'End');
        expect(useUIStore.getState().chatColumnWidth).toBe(1400);
        await key(handle(), 'keydown', 'Home'); await key(handle(), 'keyup', 'Home');
        expect(useUIStore.getState().chatColumnWidth).toBe(480);
        handle().style.direction = 'rtl';
        await key(handle(), 'keydown', 'ArrowLeft'); await key(handle(), 'keyup', 'ArrowLeft');
        expect(useUIStore.getState().chatColumnWidth).toBe(496);
        await act(async () => handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
        expect(useUIStore.getState().chatColumnWidth).toBeNull();
        expect(host.style.getPropertyValue('--oc-chat-width')).toBe('');
    });
    test('panel/window shrink changes available width without rewriting the preference', async () => {
        await act(async () => useUIStore.getState().setChatColumnWidth(1300));
        available = 700;
        await act(async () => resize?.([], { observe() {}, unobserve() {}, disconnect() {} }));
        expect(useUIStore.getState().chatColumnWidth).toBe(1300);
        expect(handle().getAttribute('aria-valuenow')).toBe('700');
        available = 1400;
        await act(async () => resize?.([], { observe() {}, unobserve() {}, disconnect() {} }));
        expect(handle().getAttribute('aria-valuenow')).toBe('1300');
        await pointer(handle(), 'pointerdown', 0); await pointer(handle(), 'pointermove', 200); await flush();
        expect(host.style.getPropertyValue('--oc-chat-width')).toBe('1400px');
        await render(false);
        expect(host.style.getPropertyValue('--oc-chat-width')).toBe('');
        expect(host.hasAttribute('data-chat-resizing')).toBe(false);
        expect(useUIStore.getState().chatColumnWidth).toBe(1300);
    });
    test('authoritative settings changes cancel a preview without persisting it', async () => {
        await pointer(handle(), 'pointerdown', 0); await pointer(handle(), 'pointermove', 100); await flush();
        await act(async () => useUIStore.getState().setChatColumnWidth(1200));
        expect(host.style.getPropertyValue('--oc-chat-width')).toBe('1200px');
        expect(host.hasAttribute('data-chat-resizing')).toBe(false);
        expect(handle().hasPointerCapture(1)).toBe(false);
        expect(handle().hasAttribute('data-resizing')).toBe(false);
    });
    test('leaving the window cancels capture and pending work without writing', async () => {
        await pointer(handle(), 'pointerdown', 0); await pointer(handle(), 'pointermove', 100);
        await act(async () => dom.dispatchEvent(new dom.Event('blur')));
        await flush();
        expect(host.style.getPropertyValue('--oc-chat-width')).toBe('');
        expect(useUIStore.getState().chatColumnWidth).toBeNull();
        expect(handle().hasPointerCapture(1)).toBe(false);
        expect(frames.size).toBe(0);
    });
    test('a click without resizing keeps the preset or a temporarily clamped preference', async () => {
        await pointer(handle(), 'pointerdown', 100); await pointer(handle(), 'pointerup', 100);
        expect(useUIStore.getState().chatColumnWidth).toBeNull();
        await act(async () => useUIStore.getState().setChatColumnWidth(1300)); available = 700;
        await act(async () => resize?.([], { observe() {}, unobserve() {}, disconnect() {} }));
        await pointer(handle(), 'pointerdown', 100); await pointer(handle(), 'pointerup', 100);
        expect(useUIStore.getState().chatColumnWidth).toBe(1300);
    });
});

import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { z } from 'zod';

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage, HTMLElement: browser.HTMLElement, Element: browser.Element, IS_REACT_ACT_ENVIRONMENT: true })) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
}
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useEnterprisePolicyStore } = await import('@/stores/useEnterprisePolicyStore');
const { OutlookConnectionSection } = await import('./OutlookConnectionSection');
const { outlookI18n } = await import('@/lib/i18n/messages/outlook.i18n');
const clientId = '11111111-1111-4111-8111-111111111111';
const operations: string[] = [];
type SyntheticCommand = { action: 'outlook'; op: string; clientId?: string; address?: string };
let authorized = false;
let pending = false;
let nativeAvailable = false;
let nativeAuthorized = false;
Object.defineProperty(browser, '__OPENCHAMBER_ELECTRON__', { value: { runtime: 'electron' }, configurable: true });
Object.defineProperty(browser, '__OPENCHAMBER_DESKTOP__', { value: {
    invoke: async (command: string, raw: SyntheticCommand) => {
        expect(command).toBe('desktop_personal_home');
        const input = z.object({ action: z.literal('outlook'), op: z.string(), clientId: z.string().optional(), address: z.string().optional() }).parse(raw);
        operations.push(input.op);
        if (input.op === 'connect') { expect(input.clientId).toBe(clientId); pending = true; }
        if (input.op === 'check') { authorized = true; pending = false; }
        if (input.op === 'disconnect') { expect(input.address).toBe('test@example.com'); authorized = false; }
        if (input.op === 'native-connect') nativeAuthorized = true;
        if (input.op === 'native-disconnect') nativeAuthorized = false;
        return { clientId: nativeAvailable ? '' : clientId, accounts: authorized ? [{ address: 'test@example.com' }] : [], pending: pending ? { code: 'TEST-CODE', expiresAt: Date.now() + 600000, nextCheckAt: Date.now() } : null,
            native: { available: nativeAvailable, access: nativeAuthorized ? 'connected' : nativeAvailable ? 'not-connected' : 'unsupported', accounts: nativeAuthorized ? [{ id: 'native:1', address: 'native@example.com' }] : [] } };
    },
}, configurable: true });

afterAll(async () => {
    await browser.happyDOM.close();
    for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
});

test('authorization UI starts only on click, displays the code, checks completion and removes local access', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const click = async (label: string) => {
        const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent === label);
        if (!button) throw new Error(`Missing button: ${label}`);
        await act(async () => button.click());
    };
    try {
        await act(async () => root.render(<I18nProvider><OutlookConnectionSection /></I18nProvider>));
        expect(operations).toEqual(['status']);
        expect(host.textContent).toContain('No Outlook accounts authorized.');
        await click('Sign in with Microsoft');
        expect(operations).toEqual(['status', 'connect']);
        expect(host.textContent).toContain('TEST-CODE');
        expect(host.textContent).not.toContain('Authorization saved for');
        expect(host.querySelector('a')?.href).toBe('https://microsoft.com/devicelogin');
        await click('Check sign-in');
        expect(host.textContent).toContain('Authorization saved for test@example.com');
        await click('Disconnect account');
        expect(host.textContent).toContain('No Outlook accounts authorized.');
        const before = operations.length;
        await act(async () => { useEnterprisePolicyStore.setState({ enterpriseMode: true }); });
        expect(host.textContent).toContain('Outlook access is unavailable under your organization policy.');
        expect(operations.length).toBe(before);
        expect(host.querySelector('input')).toBeNull();
    } finally {
        await act(async () => root.unmount());
        useEnterprisePolicyStore.setState({ enterpriseMode: false });
        host.remove();
    }
});

test('all Outlook controls and flow instructions are translated with matching placeholders', () => {
    const entries = Object.entries(outlookI18n.en);
    for (const [locale, messages] of Object.entries(outlookI18n)) {
        expect(Object.keys(messages).sort()).toEqual(Object.keys(outlookI18n.en).sort());
        for (const [key, english] of entries) {
            const value = Object.entries(messages).find(([candidate]) => candidate === key)?.[1];
            expect(value).toBeTruthy();
            expect(value?.match(/\{\w+\}/g) ?? []).toEqual(english.match(/\{\w+\}/g) ?? []);
            if (locale !== 'en' && key !== 'outlook.title') expect(value).not.toBe(english);
        }
    }
});

test('default native connection needs no Azure ID and local disconnection remains available under policy', async () => {
    nativeAvailable = true;
    operations.length = 0;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const click = async (label: string) => {
        const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent === label);
        if (!button) throw new Error(`Missing button: ${label}`);
        expect(button.disabled).toBe(false);
        await act(async () => button.click());
    };
    try {
        await act(async () => root.render(<I18nProvider><OutlookConnectionSection /></I18nProvider>));
        expect(operations).toEqual(['status']);
        expect(host.querySelector('details')?.open).toBe(false);
        await click('Connect Outlook on this Mac');
        expect(operations).toEqual(['status', 'native-connect']);
        expect(host.textContent).toContain('Authorization saved for native@example.com');
        await act(async () => { useEnterprisePolicyStore.setState({ enterpriseMode: true }); });
        await click('Disconnect account');
        expect(operations.at(-1)).toBe('native-disconnect');
        expect(host.textContent).not.toContain('Authorization saved for native@example.com');
    } finally {
        await act(async () => root.unmount());
        nativeAvailable = false;
        useEnterprisePolicyStore.setState({ enterpriseMode: false });
        host.remove();
    }
});

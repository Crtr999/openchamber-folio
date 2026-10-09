import { afterEach, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { TitlebarLeftControls } from './TitlebarLeftControls';

const initialUI = useUIStore.getState();
afterEach(() => { useUIStore.setState(initialUI, true); });

for (const isSidebarOpen of [true, false]) {
  test(`titlebar retains only the sidebar toggle with sidebar ${isSidebarOpen ? 'open' : 'closed'}`, async () => {
    useUIStore.setState({ isSidebarOpen });
    const markup = renderToStaticMarkup(<I18nProvider><TitlebarLeftControls /></I18nProvider>);
    const browser = new Window();
    browser.document.body.innerHTML = markup;
    const button = browser.document.querySelector('button[aria-label="Open sessions"]');
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe('');
    expect(button?.querySelector('use')?.getAttribute('href')).toBe('#oc-layout-left');
    expect(browser.document.querySelector('button[aria-label="New session"]')).toBeNull();
    expect(browser.document.querySelector('button[aria-label="Home"]')).toBeNull();
    await browser.happyDOM.close();
  });
}

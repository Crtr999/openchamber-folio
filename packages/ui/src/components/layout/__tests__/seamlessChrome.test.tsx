import { afterAll, afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { Sidebar } from '../Sidebar';

const initialUI = useUIStore.getState();
afterEach(() => { useUIStore.setState(initialUI, true); });

const browser = new Window();
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser),
  ResizeObserver: browser.ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true })) {
  descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true });
}
afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

// Header's context-panel import graph includes Vite workers; follow the nearby
// source-guard precedent for its intentional control order and canvas boundary.
test('runtime switch precedes the context rail control without changing its action', () => {
  const header = readFileSync(new URL('../Header.tsx', import.meta.url), 'utf8');
  const runtimePosition = header.indexOf('{desktopRuntimeAction}');
  const railPosition = header.indexOf('data-context-rail-toggle="true"');
  expect(runtimePosition).toBeGreaterThan(0);
  expect(railPosition).toBeGreaterThan(runtimePosition);
  expect(header).toContain("aria-label={t(contextRailVisible ? 'header.contextRail.hide' : 'header.contextRail.show')}");
  expect(header).toContain('onClick={() => setContextRailVisible(!contextRailVisible)}');
  expect(header).toContain('<WindowsWindowControls visible={usesFramelessChrome');
});

test('desktop canvas and rail have no top separator beneath the header', () => {
  const layout = readFileSync(new URL('../MainLayout.tsx', import.meta.url), 'utf8');
  expect(layout).not.toContain('border-t');
  expect(layout).toContain('contextRailVisible && !isWebsiteAssistantPageOpen');
  expect(layout).toContain('<ContextPanel visible={contextRailVisible && !isWebsiteAssistantPageOpen}');
});

test('a closed or unresolved context panel reserves zero width rather than its minimum', () => {
  const panel = readFileSync(new URL('../ContextPanel.tsx', import.meta.url), 'utf8');
  expect(panel).toContain("const activeTab = tabs.find((tab) => tab.id === panelState?.activeTabId) ?? null;");
  expect(panel).toContain("const panelStyle: React.CSSProperties & { '--oc-context-panel-width': string } = !isOpen");
  expect(panel).toContain('width: 0,');
  expect(panel).not.toContain('isOpen ? width : CONTEXT_PANEL_MIN_WIDTH');
  expect(panel).toContain('inert={!isOpen || undefined}');
  const rail = readFileSync(new URL('../ContextPanelRail.tsx', import.meta.url), 'utf8');
  expect(rail).toContain('<OpenRouterBalanceBadge />');
  const header = readFileSync(new URL('../Header.tsx', import.meta.url), 'utf8');
  expect(header).not.toContain('OpenRouterBalanceBadge');
  expect(rail).toContain('w-11 flex-shrink-0');
});

for (const isOpen of [true, false]) {
  test(`sidebar shares the canvas and preserves width with sidebar ${isOpen ? 'open' : 'closed'}`, async () => {
    useUIStore.setState({ sidebarWidth: 320, contextRailVisible: false });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(
      <I18nProvider><Sidebar isOpen={isOpen} isMobile={false}><div className="bg-sidebar">Sessions</div></Sidebar></I18nProvider>,
    ));
    const sidebar = host.querySelector('aside');
    expect(sidebar?.classList.contains('bg-background')).toBe(true);
    expect(sidebar?.classList.contains('border-r')).toBe(false);
    expect(sidebar?.style.getPropertyValue('--sidebar')).toBe('var(--surface-background)');
    expect(sidebar?.style.width).toBe(isOpen ? '320px' : '0px');
    expect(sidebar?.getAttribute('aria-hidden')).toBe(String(!isOpen));
    expect(browser.document.querySelector('[role="separator"]') !== null).toBe(isOpen);
    expect(useUIStore.getState().sidebarWidth).toBe(320);
    expect(useUIStore.getState().contextRailVisible).toBe(false);
    await act(async () => root.unmount());
    host.remove();
  });
}

test('mobile keeps its separate sidebar surface', () => {
  expect(renderToStaticMarkup(<I18nProvider><Sidebar isOpen isMobile>Sessions</Sidebar></I18nProvider>)).toBe('');
});

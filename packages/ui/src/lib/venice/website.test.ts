import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { VENICE_PARTITION, VENICE_URL, venicePageTitle, venicePageUrl } from './website';

test('Venice uses only the official website and a separate durable partition', () => {
  expect(VENICE_URL).toBe('https://venice.ai/chat/classic');
  expect(VENICE_PARTITION).toBe('persist:open-carter-venice');
  expect(venicePageTitle(VENICE_URL, '  Venice  ')).toBe('Venice');
  expect(venicePageTitle(VENICE_URL, 'x'.repeat(250)).length).toBe(200);
});

test('saved Venice links preserve observed paths but reject credentials and URL secrets', () => {
  expect(venicePageUrl('https://venice.ai/observed-page')).toBe('https://venice.ai/observed-page');
  for (const url of ['https://venice.ai.evil.test/page', 'http://venice.ai/page', 'https://user:pass@venice.ai/page', 'https://venice.ai/page?token=secret', 'https://venice.ai/page#secret', 'invalid']) {
    expect(venicePageUrl(url)).toBeNull();
  }
});

test('main layout retains Venice with other websites and resets its ephemeral state', () => {
  const layout = readFileSync(new URL('../../components/layout/MainLayout.tsx', import.meta.url), 'utf8');
  expect(layout).toContain('isChatGPTPageOpen || isClaudePageOpen || isVenicePageOpen');
  expect(layout).toContain('<VeniceWorkspace visible={isVenicePageOpen} />');
  expect(layout).toContain('useVeniceStore.getState().resetWebsite()');
  const shortcuts = readFileSync(new URL('../../hooks/useKeyboardShortcuts.ts', import.meta.url), 'utf8');
  expect(shortcuts).toContain('getActiveWebsiteTabId() ?? currentSessionId');
});

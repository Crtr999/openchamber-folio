import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GEMINI_PARTITION, GEMINI_URL, geminiPageTitle, geminiPageUrl } from './website';

test('Gemini uses only the official website and a separate durable partition', () => {
  expect(GEMINI_URL).toBe('https://gemini.google.com/app');
  expect(GEMINI_PARTITION).toBe('persist:open-carter-gemini');
  expect(geminiPageTitle(GEMINI_URL, '  Gemini  ')).toBe('Gemini');
  expect(geminiPageTitle(GEMINI_URL, 'x'.repeat(250)).length).toBe(200);
});

test('saved Gemini links preserve observed paths but reject credentials and URL secrets', () => {
  expect(geminiPageUrl('https://gemini.google.com/app/observed-page')).toBe('https://gemini.google.com/app/observed-page');
  for (const url of ['https://gemini.google.com.evil.test/page', 'http://gemini.google.com/page', 'https://user:pass@gemini.google.com/page', 'https://gemini.google.com/page?token=secret', 'https://gemini.google.com/page#secret', 'invalid']) {
    expect(geminiPageUrl(url)).toBeNull();
  }
});

test('main layout retains Gemini with other websites and resets its ephemeral state', () => {
  const layout = readFileSync(new URL('../../components/layout/MainLayout.tsx', import.meta.url), 'utf8');
  expect(layout).toContain('isChatGPTPageOpen || isClaudePageOpen || isVenicePageOpen || isGeminiPageOpen');
  expect(layout).toContain('<GeminiWorkspace visible={isGeminiPageOpen} />');
  expect(layout).toContain('useGeminiStore.getState().resetWebsite()');
  const shortcuts = readFileSync(new URL('../../hooks/useKeyboardShortcuts.ts', import.meta.url), 'utf8');
  expect(shortcuts).toContain('getActiveWebsiteTabId() ?? currentSessionId');
});

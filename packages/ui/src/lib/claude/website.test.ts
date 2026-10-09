import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CLAUDE_PARTITION, CLAUDE_URL, claudePageTitle, claudePageUrl } from './website';

test('Claude uses only the official website and a separate durable partition', () => {
  expect(CLAUDE_URL).toBe('https://claude.ai/');
  expect(CLAUDE_PARTITION).toBe('persist:open-carter-claude');
  expect(claudePageTitle(CLAUDE_URL, '  Claude  ')).toBe('Claude');
  expect(claudePageTitle(CLAUDE_URL, 'x'.repeat(250)).length).toBe(200);
});

test('saved Claude links preserve observed paths but reject credentials and URL secrets', () => {
  expect(claudePageUrl('https://claude.ai/observed-page')).toBe('https://claude.ai/observed-page');
  for (const url of ['https://claude.ai.evil.test/page', 'http://claude.ai/page', 'https://user:pass@claude.ai/page', 'https://claude.ai/page?token=secret', 'https://claude.ai/page#secret', 'invalid']) {
    expect(claudePageUrl(url)).toBeNull();
  }
});

test('main layout retains Claude with other websites and resets its ephemeral state', () => {
  const layout = readFileSync(new URL('../../components/layout/MainLayout.tsx', import.meta.url), 'utf8');
  expect(layout).toContain('isChatGPTPageOpen || isMusePageOpen || isClaudePageOpen');
  expect(layout).toContain('<ClaudeWorkspace visible={isClaudePageOpen} />');
  expect(layout).toContain('useClaudeStore.getState().resetWebsite()');
  const shortcuts = readFileSync(new URL('../../hooks/useKeyboardShortcuts.ts', import.meta.url), 'utf8');
  expect(shortcuts).toContain('getActiveWebsiteTabId() ?? currentSessionId');
});

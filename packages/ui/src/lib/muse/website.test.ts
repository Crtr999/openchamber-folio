import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { MUSE_URL, MUSE_PARTITION, musePageUrl, musePageTitle } from './website';

test('Muse opens the standalone service in its own durable partition', () => {
  expect(MUSE_URL).toBe('https://muse.ai/');
  expect(MUSE_PARTITION).toBe('persist:open-carter-muse');
});

test('saved links reject external origins, credentials and authentication parameters', () => {
  expect(musePageUrl('https://muse.ai/')).toBe(MUSE_URL);
  expect(musePageUrl('https://muse.ai/an-observed-page')).toBe('https://muse.ai/an-observed-page');
  for (const url of ['https://muse.ai.evil.test/chat', 'http://muse.ai/', 'https://user:password@muse.ai/', 'https://muse.ai/?token=secret', 'https://muse.ai/#token', 'invalid']) {
    expect(musePageUrl(url)).toBeNull();
  }
  expect(musePageTitle('https://muse.ai/', '  My page  ')).toBe('My page');
  expect(musePageTitle('https://login.example/', 'Account')).toBe('');
});

test('full-site wrapper does not scrape account data or hide website navigation', () => {
  const workspace = readFileSync(new URL('../../components/views/MuseWorkspace.tsx', import.meta.url), 'utf8');
  expect(workspace).toContain('src={MUSE_URL} partition={MUSE_PARTITION}');
  expect(workspace).not.toContain('executeJavaScript');
  expect(workspace).not.toContain('setInterval');
  expect(workspace).not.toContain('integrated');
  const controls = readFileSync(new URL('../../components/chat/ModelControls.tsx', import.meta.url), 'utf8');
  // The model picker may open the Muse website tab; it never opens a native Muse chat.
  expect(controls).not.toContain('openNativeMuse');
});

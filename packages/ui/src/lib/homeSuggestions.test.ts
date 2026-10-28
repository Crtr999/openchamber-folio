import { expect, test } from 'bun:test';
import { dismissHomeSuggestion, homeSuggestionHeadline, readHomeSuggestions, type HomeSuggestion } from './homeSuggestions';
import type { runtimeFetch } from './runtime-fetch';

const entry = { id: 'ses_fixture', title: 'Personal review', excerpt: 'Prepare the project review', createdAt: 1, seen: false, dismissed: false };
const folder = { id: 'folder /1', path: '/work/public', label: 'Studio' };
const item: HomeSuggestion = { ...entry, projectId: folder.id, directory: folder.path, friend: folder.label };
const signal = () => new AbortController().signal;
const json = (value: Parameters<typeof JSON.stringify>[0], status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('reads only existing unread nondismissed results, in date order with exact source identity', async () => {
  const calls: string[] = [];
  const request: typeof runtimeFetch = async (path, init) => {
    calls.push(String(path));
    expect(init?.signal).toBeDefined();
    return json({ inbox: [entry, { ...entry, id: 'new', createdAt: 2 }, { ...entry, id: 'read', seen: true },
      { ...entry, id: 'dismissed', dismissed: true }, { ...entry, id: 'blank', excerpt: '  ' }] });
  };
  const result = await readHomeSuggestions([folder], signal(), request);
  expect(calls).toEqual(['/api/projects/folder%20%2F1/companion/inbox']);
  expect(result.failedProjectIds).toEqual([]);
  expect(result.items.map(value => value.id)).toEqual(['new', 'ses_fixture']);
  expect(result.items[0]).toMatchObject({ directory: folder.path, friend: 'Studio', projectId: folder.id });
});

test('denied folders are omitted, failures stay distinct from authoritative empty and do not block other folders', async () => {
  const request: typeof runtimeFetch = async path => {
    if (String(path).includes('/denied/')) return json({ error: 'Excluded' }, 403);
    if (String(path).includes('/failed/')) return json({ error: 'Unavailable' }, 503);
    if (String(path).includes('/malformed/')) return json({ inbox: [{ ...entry, createdAt: 'yesterday' }] });
    if (String(path).includes('/empty/')) return json({ inbox: [] });
    return json({ inbox: [entry] });
  };
  const result = await readHomeSuggestions(['denied', 'failed', 'malformed', 'empty', 'ready'].map(id => ({ ...folder, id })), signal(), request);
  expect(result.failedProjectIds).toEqual(['failed', 'malformed']);
  expect(result.items.map(value => value.projectId)).toEqual(['ready']);
});

test('abort rejects instead of reporting an empty successful inbox', async () => {
  const controller = new AbortController(); controller.abort();
  const request: typeof runtimeFetch = async () => { throw new Error('Aborted'); };
  await expect(readHomeSuggestions([folder], controller.signal, request)).rejects.toThrow('Aborted');
});

test('dismissal uses the existing durable endpoint and validates acknowledgement', async () => {
  const requests: Array<{ path: string; method?: string; body: BodyInit | null | undefined }> = [];
  const request: typeof runtimeFetch = async (path, init) => {
    requests.push({ path: String(path), method: init?.method, body: init?.body });
    return json({ inbox: [] });
  };
  await dismissHomeSuggestion(item, signal(), request);
  expect(requests).toEqual([{ path: '/api/projects/folder%20%2F1/companion/inbox/ses_fixture', method: 'PATCH', body: '{"dismissed":true}' }]);
  await expect(dismissHomeSuggestion(item, signal(), async () => json({ error: 'Write failed' }, 500))).rejects.toThrow();
  await expect(dismissHomeSuggestion(item, signal(), async () => json({ saved: true }))).rejects.toThrow();
});

test('headline preserves source wording, including Unicode, and falls back only for empty excerpts', () => {
  expect(homeSuggestionHeadline({ title: 'Review', excerpt: '\n## 明日の準備\nEvidence' })).toBe('明日の準備');
  expect(homeSuggestionHeadline({ title: 'Review', excerpt: '1. Prepare the review\nSource' })).toBe('Prepare the review');
  expect(homeSuggestionHeadline({ title: 'Review', excerpt: '' })).toBe('Review');
});

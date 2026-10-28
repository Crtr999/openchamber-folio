import { expect, test } from 'bun:test';
import { validateWebsiteModelStart, websiteModelContinuationSchema, websiteModelTurn } from './modelJob';
import { websiteChatSnapshotSchema } from './websiteChat';

const page = (messages: Array<{ role: 'user' | 'assistant'; text: string }>, userCount = messages.filter(row => row.role === 'user').length) => {
  const parsed = websiteChatSnapshotSchema.parse({ kind: 'ready', url: 'https://gemini.google.com/app/observed', account: 'fixture', messages: messages.map(row => ({ ...row, rich: false })), userCount, busy: false, draft: '', partial: false });
  if (parsed.kind !== 'ready') throw Error('Fixture is not ready');
  return parsed;
};
const start = page([{ role: 'user', text: 'First prompt' }, { role: 'assistant', text: 'First answer' }]);
const continuation = async () => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('First answer'));
  return { url: start.url, userCount: 1, answerHash: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') };
};

test('only the exact observed, unchanged Gemini conversation can be reused', async () => {
  const owned = await continuation();
  expect(await validateWebsiteModelStart(start, owned)).toBeUndefined();
  for (const changed of [
    { ...start, url: 'https://gemini.google.com/app/other' },
    { ...start, userCount: 2 }, { ...start, busy: true }, { ...start, draft: 'personal draft' },
    { ...start, partial: true }, page([{ role: 'assistant', text: 'Changed answer' }], 1),
  ]) await expect(validateWebsiteModelStart(changed, owned)).rejects.toThrow();
  await expect(validateWebsiteModelStart(start)).rejects.toThrow('fresh chat');
  expect(await validateWebsiteModelStart(page([]))).toBeUndefined();
});

test('continuation URLs reject foreign origins, credentials, queries and fragments', async () => {
  const owned = await continuation();
  for (const url of ['https://evil.test/app/observed', 'https://gemini.google.com/app', 'https://x@gemini.google.com/app/observed', start.url + '?token=x', start.url + '#x']) {
    expect(websiteModelContinuationSchema.safeParse({ ...owned, url }).success).toBe(false);
  }
});

test('old history and blank new user DOM cannot acknowledge or replay an old answer', () => {
  expect(websiteModelTurn(start, start)).toEqual({ acknowledged: false, answer: null });
  expect(websiteModelTurn({ ...start, userCount: 2 }, start)).toEqual({ acknowledged: false, answer: null });
  const waiting = page([...start.messages, { role: 'user', text: 'Tool results' }]);
  expect(websiteModelTurn(waiting, start)).toEqual({ acknowledged: true, answer: null });
  const completed = page([...waiting.messages, { role: 'assistant', text: 'New answer' }]);
  expect(websiteModelTurn(completed, start).answer?.text).toBe('New answer');
  expect(websiteModelTurn({ ...completed, partial: true }, start).answer).toBeNull();
});

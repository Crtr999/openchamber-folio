import { beforeEach, describe, expect, test } from 'bun:test';
import { createChatSearchCache, searchChats, type ChatSearchProgress } from './chat-search';
import { useZdrLockStore } from '@/stores/useZdrLockStore';
import type { Session, Message, Part } from './model';
const session = (id: string, directory = '/project'): Session => ({ id, directory, projectID: 'p', title: id, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } });
type SearchItem = { info: Message; parts: Part[] };
const item = (id: string, text: string, created = 10): SearchItem => ({ info: { id, sessionID: 's', role: 'user', time: { created } }, parts: [{ id: `${id}-text`, sessionID: 's', messageID: id, type: 'text', text }] });
const run = async (query: string, messages: Parameters<typeof searchChats>[1]['messages'], cache = createChatSearchCache()) => {
  let result: ChatSearchProgress | undefined;
  await searchChats({ query }, { sessions: async () => ({ sessions: [session('s')], cursor: {} }), messages }, new AbortController().signal, value => { result = value; }, cache);
  return result;
};
describe('chat content search', () => {
  beforeEach(() => useZdrLockStore.setState({ loaded: true, pinSet: false, unlocked: false, directories: [] }));
  test('does not read chats while lock state is unknown or after a lock during a read', async () => {
    useZdrLockStore.setState({ loaded: false });
    let reads = 0;
    const loader = async () => { reads++; return { items: [item('m', 'alpha')], cursor: {} }; };
    expect((await run('alpha', loader))?.matches).toHaveLength(0);
    expect(reads).toBe(0);
    useZdrLockStore.setState({ loaded: true, pinSet: true, unlocked: true, directories: ['/project'] });
    const result = await run('alpha', async () => { useZdrLockStore.getState().lock(); return loader(); });
    expect(result?.matches).toHaveLength(0);
  });
  test('finds older pages and attachment names; excludes reasoning and injected system text', async () => {
    const first = item('m1', 'unrelated');
    first.parts.push({ id: 'f', sessionID: 's', messageID: 'm1', type: 'file', mime: 'text/plain', filename: 'contract.md', url: 'private' });
    const injected: Message = { id: 'system', sessionID: 's', role: 'system', time: { created: 12 }, text: 'contract' };
    const result = await run('contract', async (_session, cursor) => cursor ? { items: [item('old', 'The CONTRACT matters', 2)], cursor: {} } : { items: [first, { info: injected, parts: [] }], cursor: { next: 'old' } });
    expect(result?.matches.map(match => match.messageId)).toEqual(['m1', 'old']);
    expect(result?.matches[0].attachments).toEqual(['contract.md']);
  });
  test('reuses only text records across rolling queries and invalidates by session update', async () => {
    let reads = 0;
    const cache = createChatSearchCache();
    const loader = async () => { reads++; return { items: [item('m', 'alpha beta')], cursor: {} }; };
    expect((await run('alpha', loader, cache))?.matches).toHaveLength(1);
    expect((await run('beta', loader, cache))?.matches).toHaveLength(1);
    expect(reads).toBe(1);
    expect(JSON.stringify([...cache.pages.values()])).not.toContain('metadata');
  });
  test('bounds previews while retaining the matching passage', async () => {
    const result = await run('needle', async () => ({ items: [item('long', 'x'.repeat(7000) + 'needle')], cursor: {} }));
    expect(result?.matches[0].preview).toContain('needle');
    expect(result?.matches[0].preview.length).toBeLessThanOrEqual(6000);
    expect(result?.matches[0].previewTruncated).toBe(true);
  });
  test('cancellation prevents late results and stops queued reads', async () => {
    const abort = new AbortController();
    let published = 0;
    let reads = 0;
    await expect(searchChats({ query: 'alpha' }, { sessions: async () => ({ sessions: Array.from({ length: 8 }, (_, i) => session(String(i))), cursor: {} }), messages: async () => { reads++; abort.abort(); return { items: [item('m', 'alpha')], cursor: {} }; } }, abort.signal, () => { published++; })).rejects.toThrow();
    expect(reads).toBeLessThanOrEqual(4);
    expect(published).toBe(1);
  });
  test('reports failed chats and caps retained excerpts', async () => {
    expect((await run('alpha', async () => { throw new Error('offline'); }))?.failed).toBe(1);
    const result = await run('alpha', async () => ({ items: Array.from({ length: 250 }, (_, i) => item(String(i), 'alpha')), cursor: {} }));
    expect(result?.matches).toHaveLength(200); expect(result?.limited).toBe(true);
  });
  test('applies project, date, model and attachment filters to each message', async () => {
    let result: ChatSearchProgress | undefined;
    const message = item('m', 'alpha', 20);
    message.info = { id: 'm', sessionID: 's', role: 'assistant', time: { created: 20 }, providerID: 'provider', modelID: 'model', agent: 'build' };
    message.parts.push({ id: 'f', sessionID: 's', messageID: 'm', type: 'file', mime: 'text/plain', filename: 'alpha.txt', url: 'private' });
    await searchChats({ query: 'alpha', directory: '/project', after: 15, before: 25, model: 'model', attachmentsOnly: true }, { sessions: async () => ({ sessions: [session('s'), session('outside', '/else')], cursor: {} }), messages: async () => ({ items: [message, item('old', 'alpha', 1)], cursor: {} }) }, new AbortController().signal, value => { result = value; });
    expect(result?.total).toBe(1); expect(result?.matches.map(match => match.messageId)).toEqual(['m']);
  });
});

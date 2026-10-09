import type { MessagePage, SessionPage } from './client';
import type { Session } from './model';

export type ChatSearchFilters = { query: string; directory?: string; after?: number; before?: number; model?: string; attachmentsOnly?: boolean };
export type ChatSearchMatch = { sessionId: string; messageId: string; directory: string; title: string; created: number; excerpt: string; preview: string; previewTruncated: boolean; attachments: string[]; model: string };
export type ChatSearchProgress = { completed: number; total: number; failed: number; limited: boolean; matches: ChatSearchMatch[] };
type SearchRecord = { id: string; created: number; model: string; text: string; attachments: string[] };
type SearchPage = { items: SearchRecord[]; next?: string };
export type ChatSearchCache = { pages: Map<string, SearchPage>; characters: number };
export const createChatSearchCache = (): ChatSearchCache => ({ pages: new Map(), characters: 0 });
const CACHE_CHARACTER_LIMIT = 4_000_000;
const extractPage = (page: MessagePage): SearchPage => ({ next: page.cursor.next, items: page.items.flatMap(({ info, parts }) => {
  if (info.role !== 'user' && info.role !== 'assistant') return [];
  return [{ id: info.id, created: info.time.created,
    model: info.role === 'assistant' ? `${info.providerID}/${info.modelID}` : '',
    text: parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'),
    attachments: parts.flatMap(part => part.type === 'file' && part.filename ? [part.filename] : []) }];
}) });
type Loaders = { sessions: (cursor?: string) => Promise<SessionPage>; messages: (session: Session, cursor?: string) => Promise<MessagePage> };

/** Debounced callers run a cancellable scan; four readers, page-sized transient storage and 200 excerpts. */
export async function searchChats(filters: ChatSearchFilters, loaders: Loaders, signal: AbortSignal, progress: (value: ChatSearchProgress) => void, cache?: ChatSearchCache): Promise<void> {
  const query = filters.query.trim().toLocaleLowerCase();
  if (query.length < 2) throw new Error('Query is too short');
  const sessions: Session[] = [];
  const seenSessions = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    signal.throwIfAborted();
    const page = await loaders.sessions(cursor);
    signal.throwIfAborted();
    for (const session of page.sessions) {
      if (seenSessions.has(session.id)) continue;
      seenSessions.add(session.id);
      if (!filters.directory || session.directory === filters.directory || session.directory.startsWith(`${filters.directory}/`)) sessions.push(session);
    }
    cursor = page.cursor.next;
    if (cursor && cursors.has(cursor)) throw new Error('Repeated session cursor');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  let next = 0;
  const state: ChatSearchProgress = { completed: 0, total: sessions.length, failed: 0, limited: false, matches: [] };
  const publish = () => progress({ ...state, matches: [...state.matches].sort((a, b) => b.created - a.created || a.messageId.localeCompare(b.messageId)) });
  publish();
  const worker = async () => {
    while (next < sessions.length && !state.limited) {
      signal.throwIfAborted();
      const session = sessions[next++];
      try {
        let messageCursor: string | undefined;
        const seen = new Set<string>();
        const messageIds = new Set<string>();
        do {
          signal.throwIfAborted();
          const key = JSON.stringify([session.directory, session.id, messageCursor ?? '', session.time.updated]);
          let page = cache?.pages.get(key);
          if (!page) {
            const loaded = await loaders.messages(session, messageCursor);
            signal.throwIfAborted();
            page = extractPage(loaded);
            const characters = page.items.reduce((sum, item) => sum + item.text.length + item.attachments.join('').length + 256, 0);
            if (cache && cache.characters + characters <= CACHE_CHARACTER_LIMIT) { cache.pages.set(key, page); cache.characters += characters; }
          }
          signal.throwIfAborted();
          for (const item of page.items) {
            if (messageIds.has(item.id)) continue;
            messageIds.add(item.id);
            const { created, model, attachments, text } = item;
            if ((filters.after !== undefined && created < filters.after) || (filters.before !== undefined && created >= filters.before)) continue;
            if (filters.model && !model.toLocaleLowerCase().includes(filters.model.toLocaleLowerCase())) continue;
            if (filters.attachmentsOnly && attachments.length === 0) continue;
            const haystack = [text, ...attachments].join('\n');
            const index = haystack.toLocaleLowerCase().indexOf(query);
            if (index < 0) continue;
            if (state.matches.length >= 200) { state.limited = true; break; }
            const previewStart = haystack.length > 6000 ? Math.max(0, index - 1000) : 0;
            state.matches.push({ sessionId: session.id, messageId: item.id, directory: session.directory, title: session.title, created, model, attachments, preview: haystack.slice(previewStart, previewStart + 6000), previewTruncated: haystack.length > 6000, excerpt: `${index > 100 ? '…' : ''}${haystack.slice(Math.max(0, index - 100), index + query.length + 180)}${haystack.length > index + query.length + 180 ? '…' : ''}` });
          }
          publish();
          messageCursor = page.next;
          if (messageCursor && seen.has(messageCursor)) throw new Error('Repeated message cursor');
          if (messageCursor) seen.add(messageCursor);
          if (messageCursor) await new Promise<void>(resolve => setTimeout(resolve, 0));
        } while (messageCursor && !state.limited);
      } catch (error) {
        if (signal.aborted) throw error;
        state.failed++;
      }
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      signal.throwIfAborted();
      state.completed++;
      publish();
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, sessions.length) }, worker));
}

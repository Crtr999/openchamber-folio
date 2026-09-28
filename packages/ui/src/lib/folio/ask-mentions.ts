import type { FolioNote } from '@/lib/folio/schema';

/**
 * What an "@" in the Ask AI composer can point at.
 *
 * A page carries its own text into the send, a named chat is handed to the
 * agent as something it can read, a file names the page it is attached to, and
 * a skill is attached to the prompt through the send path. Every kind below
 * comes from state the app already holds; a group with nothing behind it is not
 * drawn, so the list never shows a heading the user cannot fill.
 */
export type AskMentionKind = 'page' | 'chat' | 'file' | 'skill';

export interface AskMention {
  kind: AskMentionKind;
  /** Stable identity within its kind, used as the listbox key. */
  id: string;
  /** The text the composer inserts, without the leading "@". */
  label: string;
  /** The line beside the label: the parent page, or what the item is. */
  detail?: string;
  /** The page a file is attached to, so the send can include that page. */
  pageID?: string;
  icon?: string;
}

export interface AskMentionGroup {
  kind: AskMentionKind;
  items: AskMention[];
}

/** One result list is capped so that a large group cannot fill the picker. */
export const ASK_MENTION_LIMIT = 8;

/** A session as the picker needs to see it, before it becomes a mention. */
export interface AskMentionChatSource {
  id: string;
  title: string;
  parentID?: string;
}

/**
 * The conversations the Chats group offers, from the app's session list.
 *
 * A subagent run is a machine-made child of the conversation that spawned it,
 * and OpenCode marks it in the title with a trailing "(@agent subagent)" — for
 * example "Fixing app UI (@explorer subagent)". That marker is the honest test:
 * a nested conversation the user started has a parent link too but no marker,
 * and it is still something they can @. Matching on the parent link alone would
 * drop real nested conversations; matching on the word "subagent" would drop
 * "A conversation about subagents", which is the user's own page.
 *
 * A session the server reports without a title is still a conversation. It is
 * offered under the untitled label rather than dropped, because the sidebar
 * and the command palette both list it and this picker used to be the one
 * surface where it vanished.
 */
const subagentMarker = /\(@[^)]* subagent\)\s*$/;

export function askMentionChats(
  sessions: readonly AskMentionChatSource[],
  untitledLabel: string,
): { id: string; title: string }[] {
  return sessions
    .filter((session) => !subagentMarker.test(session.title))
    .map((session) => ({ id: session.id, title: session.title.trim() || untitledLabel }));
}

const normalize = (value: string) => value.trim().toLowerCase();

const matches = (query: string, ...fields: Array<string | undefined>) => {
  const needle = normalize(query);
  if (!needle) return true;
  return fields.some((field) => normalize(field ?? '').includes(needle));
};

/** Prefix matches first, then the caller's own order, and never more than the cap. */
const rank = <T,>(items: readonly T[], query: string, key: (item: T) => string, tiebreak?: (a: T, b: T) => number) => {
  const needle = normalize(query);
  return [...items]
    .sort((a, b) => Number(!normalize(key(a)).startsWith(needle)) - Number(!normalize(key(b)).startsWith(needle)) || (tiebreak?.(a, b) ?? 0))
    .slice(0, ASK_MENTION_LIMIT);
};

/**
 * A page is offerable when it is a page the user can still open: not trashed,
 * and not the assistant's own conversation mirror, which is a chat rather than
 * a note. This is the rule the notes-only picker already used.
 */
const isPage = (note: FolioNote) => !note.trashed && !note.isChat;

/** Every file is an attachment block on a page, so it is named by the page that holds it. */
const filesOf = (notes: readonly FolioNote[]): AskMention[] =>
  notes.filter(isPage).flatMap((note) =>
    note.blocks
      .filter((block) => block.kind === 'attachment' && block.text)
      .map((block) => ({
        kind: 'file' as const,
        id: `${note.id}:${block.id}`,
        label: block.text,
        detail: note.title,
        pageID: note.id,
      })),
  );

/**
 * Every group the composer can reach, each narrowed by what the user has typed.
 *
 * The query is applied to every group on its own, so one word finds a page, a
 * chat, a file and a skill at once. Groups that come back empty are dropped so
 * the picker only ever offers something it can act on.
 */
export function collectAskMentions(
  notes: readonly FolioNote[],
  chats: readonly { id: string; title: string }[],
  skills: readonly { name: string; description?: string }[],
  query: string,
  parentTitle: (id: string | undefined) => string | undefined,
): AskMentionGroup[] {
  // Ties keep the pages-only picker's order: what changed most recently first.
  const pages = rank(
    notes.filter((note) => isPage(note) && matches(query, note.title)),
    query,
    (note) => note.title,
    (a, b) => b.modified - a.modified,
  ).map((note) => ({ kind: 'page' as const, id: note.id, label: note.title, icon: note.icon, detail: parentTitle(note.parentID) }));

  const conversations = rank(
    chats.filter((chat) => matches(query, chat.title)),
    query,
    (chat) => chat.title,
  ).map((chat) => ({ kind: 'chat' as const, id: chat.id, label: chat.title }));

  const files = rank(
    filesOf(notes).filter((file) => matches(query, file.label, file.detail)),
    query,
    (file) => file.label,
  );

  const installed = rank(
    skills.filter((skill) => matches(query, skill.name, skill.description)),
    query,
    (skill) => skill.name,
  ).map((skill) => ({ kind: 'skill' as const, id: skill.name, label: skill.name, detail: skill.description }));

  const all: AskMentionGroup[] = [
    { kind: 'page', items: pages },
    { kind: 'chat', items: conversations },
    { kind: 'file', items: files },
    { kind: 'skill', items: installed },
  ];
  return all.filter((entry) => entry.items.length > 0);
}

/** The results as one list, in group order, which is what the keyboard walks. */
export function flattenAskMentions(groups: readonly AskMentionGroup[]): AskMention[] {
  return groups.flatMap((entry) => entry.items);
}

/** The next index, wrapping at both ends, so arrows never dead-end. */
export function nextAskMentionIndex(current: number, total: number, step: 1 | -1): number {
  if (total <= 0) return 0;
  return (current + step + total) % total;
}

export type AskComposerAction = 'move-next' | 'move-previous' | 'choose' | 'close' | 'send' | 'none';

/**
 * What one keystroke in the composer does.
 *
 * The open list owns the arrow keys, Enter and Tab; Escape only closes it;
 * Enter sends the question once it is out of the way, and only when the user
 * is not composing text or asking for a newline.
 */
export function askComposerAction(
  key: string,
  listOpen: boolean,
  resultCount: number,
  shiftKey: boolean,
  composing: boolean,
): AskComposerAction {
  const browsable = listOpen && resultCount > 0;
  if (browsable && key === 'ArrowDown') return 'move-next';
  if (browsable && key === 'ArrowUp') return 'move-previous';
  if (browsable && (key === 'Enter' || key === 'Tab')) return 'choose';
  if (listOpen && key === 'Escape') return 'close';
  if (key === 'Enter' && !shiftKey && !composing) return 'send';
  return 'none';
}

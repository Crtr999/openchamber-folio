import { describe, expect, test } from 'bun:test';

import type { FolioNote } from './schema';
import { ASK_MENTION_LIMIT, askComposerAction, askMentionChats, collectAskMentions, flattenAskMentions, nextAskMentionIndex } from './ask-mentions';

const page = (id: string, title: string, extra: Partial<FolioNote> = {}): FolioNote => ({
  id,
  title,
  icon: '',
  blocks: [],
  tags: [],
  favorite: false,
  excludedFromAI: false,
  isMeeting: false,
  trashed: false,
  created: 1,
  modified: 1,
  ...extra,
});

const attachment = (id: string, filename: string) => ({
  id,
  kind: 'attachment' as const,
  text: filename,
  checked: false,
  highlight: 'none' as const,
});

const notes: FolioNote[] = [
  page('11111111-1111-1111-1111-111111111111', 'Villanova Law'),
  page('22222222-2222-2222-2222-222222222222', 'Constitutional Law', { parentID: '11111111-1111-1111-1111-111111111111' }),
  page('33333333-3333-3333-3333-333333333333', 'Casebook notes', { blocks: [attachment('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Sylvanyn syllabus.pdf')] }),
  page('44444444-4444-4444-4444-444444444444', 'Old syllabus', { trashed: true }),
  page('55555555-5555-5555-5555-555555555555', 'Phone conversation', { isChat: true }),
];

const chats = [{ id: 'ses_1', title: 'Constitutional Law outline' }, { id: 'ses_2', title: 'Notes on torts' }];
const skills = [{ name: 'dataviz', description: 'Charts that read well' }, { name: 'deploy' }];
const parentTitle = (id: string | undefined) => (id === '11111111-1111-1111-1111-111111111111' ? 'Villanova Law' : undefined);

const all = collectAskMentions(notes, chats, skills, '', parentTitle);

describe('which sessions the Chats group offers', () => {
  test('a conversation is a session with no parent, whatever its title says', () => {
    const offered = askMentionChats([
      { id: 'ses_root', title: 'General Chat' },
      { id: 'ses_subagent', title: 'General Chat (@explorer subagent)', parentID: 'ses_root' },
      { id: 'ses_nested', title: 'A conversation about subagents', parentID: 'ses_root' },
    ], 'Untitled');
    // The third row proves the rule is the parent link and not the word
    // "subagent": a conversation the user started is never excluded.
    expect(offered).toEqual([{ id: 'ses_root', title: 'General Chat' }, { id: 'ses_nested', title: 'A conversation about subagents' }]);
  });

  test('a conversation the server left untitled is still offered, under a label', () => {
    const offered = askMentionChats([{ id: 'ses_blank', title: '' }, { id: 'ses_blank2', title: '   ' }], 'Untitled');
    expect(offered).toEqual([{ id: 'ses_blank', title: 'Untitled' }, { id: 'ses_blank2', title: 'Untitled' }]);
  });
});

describe('the Ask AI mention picker', () => {
  test('offers more than one kind of thing, grouped', () => {
    expect(all.map((group) => group.kind)).toEqual(['page', 'chat', 'file', 'skill']);
    // The notes the picker already offered are still offered.
    expect(all[0].items.map((item) => item.label)).toEqual(['Villanova Law', 'Constitutional Law', 'Casebook notes']);
  });

  test('leaves out a page that is trashed or is a conversation, as it always did', () => {
    const labels = all.flatMap((group) => group.items.map((item) => item.label));
    expect(labels).not.toContain('Old syllabus');
    expect(labels).not.toContain('Phone conversation');
  });

  test('names the parent page beside a page that has one', () => {
    expect(all[0].items.find((item) => item.label === 'Constitutional Law')?.detail).toBe('Villanova Law');
  });

  test('points a file at the page it is attached to', () => {
    const file = all.find((group) => group.kind === 'file')?.items[0];
    expect(file?.label).toBe('Sylvanyn syllabus.pdf');
    expect(file?.pageID).toBe('33333333-3333-3333-3333-333333333333');
  });

  test('searches every group, not only pages', () => {
    const groups = collectAskMentions(notes, chats, skills, 'constitutional', parentTitle);
    expect(groups.map((group) => group.kind)).toEqual(['page', 'chat']);
    expect(groups[0].items.map((item) => item.label)).toEqual(['Constitutional Law']);
    expect(groups[1].items.map((item) => item.label)).toEqual(['Constitutional Law outline']);
  });

  test('finds a file and a skill by their own words', () => {
    expect(flattenAskMentions(collectAskMentions(notes, chats, skills, 'syllabus', parentTitle)).map((item) => item.label)).toEqual(['Sylvanyn syllabus.pdf']);
    expect(flattenAskMentions(collectAskMentions(notes, chats, skills, 'charts', parentTitle)).map((item) => item.label)).toEqual(['dataviz']);
  });

  test('drops a group with nothing behind it rather than drawing an empty heading', () => {
    expect(collectAskMentions(notes, chats, skills, 'torts', parentTitle).map((group) => group.kind)).toEqual(['chat']);
  });

  test('says so rather than offering nothing when nothing matches', () => {
    expect(collectAskMentions(notes, chats, skills, 'zzzz', parentTitle)).toEqual([]);
  });

  test('ranks a prefix match first and keeps a group to its cap', () => {
    const many = Array.from({ length: ASK_MENTION_LIMIT + 4 }, (_, index) => page(`0000000${index}-0000-0000-0000-000000000000`, index === 0 ? 'Torts Law' : `Notes about torts ${index}`, { modified: index }));
    const group = collectAskMentions(many, [], [], 'torts', parentTitle)[0];
    expect(group.items).toHaveLength(ASK_MENTION_LIMIT);
    expect(group.items[0].label).toBe('Torts Law');
    expect(group.items[1].label).toBe(`Notes about torts ${ASK_MENTION_LIMIT + 3}`);
  });

  test('keeps the pages-only order among equally good matches', () => {
    const group = collectAskMentions([
      page('11111111-1111-1111-1111-111111111111', 'Older', { modified: 1 }),
      page('22222222-2222-2222-2222-222222222222', 'Newer', { modified: 9 }),
    ], [], [], 'e', parentTitle)[0];
    expect(group.items.map((item) => item.label)).toEqual(['Newer', 'Older']);
  });
});

describe('mention picker navigation', () => {
  test('walks every result across group boundaries and wraps at both ends', () => {
    const total = flattenAskMentions(all).length;
    expect(total).toBeGreaterThan(3);
    expect(nextAskMentionIndex(0, total, 1)).toBe(1);
    expect(nextAskMentionIndex(total - 1, total, 1)).toBe(0);
    expect(nextAskMentionIndex(0, total, -1)).toBe(total - 1);
    expect(nextAskMentionIndex(3, total, 1)).toBe(4);
    expect(nextAskMentionIndex(0, 0, 1)).toBe(0);
  });
});

describe('what a keystroke in the composer does', () => {
  const total = 6;
  // Arrows, Enter and Tab belong to the open list, so they must not reach the
  // send path while a result is highlighted.
  test('the open list takes the arrow keys, Enter and Tab', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Tab']) {
      expect(askComposerAction(key, true, total, false, false)).not.toBe('send');
    }
    expect(askComposerAction('ArrowDown', true, total, false, false)).toBe('move-next');
    expect(askComposerAction('ArrowUp', true, total, false, false)).toBe('move-previous');
    expect(askComposerAction('Enter', true, total, false, false)).toBe('choose');
    expect(askComposerAction('Tab', true, total, false, false)).toBe('choose');
  });

  test('an open list with nothing in it still closes on Escape', () => {
    expect(askComposerAction('Escape', true, 0, false, false)).toBe('close');
    expect(askComposerAction('Enter', true, 0, false, false)).toBe('send');
  });

  test('Escape closes the list and Enter sends once it is gone', () => {
    expect(askComposerAction('Escape', false, 0, false, false)).toBe('none');
    expect(askComposerAction('Enter', false, 0, false, false)).toBe('send');
  });

  test('Shift+Enter and a composing Enter insert a line instead of sending', () => {
    expect(askComposerAction('Enter', false, 0, true, false)).toBe('none');
    expect(askComposerAction('Enter', false, 0, false, true)).toBe('none');
  });

  test('an arrow with no list open is left to the composer', () => {
    expect(askComposerAction('ArrowDown', false, 0, false, false)).toBe('none');
    expect(askComposerAction('a', false, 0, false, false)).toBe('none');
  });
});

import { expect, test } from 'bun:test';

import { allChatsProject, isAllChatsProject, isWithinChatsRoot, sessionBelongsToFriend } from './allChatsFriend';

/**
 * All Chats is a friend, and it is the one friend whose conversations do not
 * live in its own path: each one gets a dated directory under the chats root.
 */

const CHATS_ROOT = '/home/user/.config/openchamber/chats';
const ALL_CHATS = allChatsProject(CHATS_ROOT)!;

test('the All Chats friend is built from the chats root', () => {
    expect(ALL_CHATS.id).toBe('openchamber:chats');
    expect(ALL_CHATS.path).toBe(CHATS_ROOT);
    expect(isAllChatsProject(ALL_CHATS)).toBe(true);
    expect(isAllChatsProject({ id: 'some-project' })).toBe(false);
});

test('there is no All Chats friend without a chats root', () => {
    expect(allChatsProject(null)).toBeNull();
    expect(allChatsProject('  ')).toBeNull();
});

test('a conversation under the chats root belongs to All Chats', () => {
    expect(sessionBelongsToFriend(ALL_CHATS, { directory: `${CHATS_ROOT}/2026-10-19/session-abc` })).toBe(true);
    expect(sessionBelongsToFriend(ALL_CHATS, { directory: CHATS_ROOT })).toBe(true);
    expect(sessionBelongsToFriend(ALL_CHATS, { directory: '/home/user/work/folder' })).toBe(false);
    expect(sessionBelongsToFriend(ALL_CHATS, { directory: null })).toBe(false);
});

test('a folder friend owns exactly its own path', () => {
    const folder = { id: 'p1', path: '/home/user/work/folder' };
    expect(sessionBelongsToFriend(folder, { directory: '/home/user/work/folder' })).toBe(true);
    // A nested folder is a different friend, and its conversations are not
    // this one's — the rule that keeps two folders from sharing a memory.
    expect(sessionBelongsToFriend(folder, { directory: '/home/user/work/folder/nested' })).toBe(false);
    expect(sessionBelongsToFriend(folder, { directory: '/home/user/work/folder-other' })).toBe(false);
});

test('the chats root test does not match a sibling with the same prefix', () => {
    expect(isWithinChatsRoot(`${CHATS_ROOT}-other/2026`, CHATS_ROOT)).toBe(false);
    expect(isWithinChatsRoot(`${CHATS_ROOT}/2026`, CHATS_ROOT)).toBe(true);
});

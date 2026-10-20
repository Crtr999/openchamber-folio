import { expect, test } from 'bun:test';

import { readFriendProfiles, saveFriendProfile } from '@/lib/friends';
import { allChatsFriendName } from '@/lib/allChatsFriend';

/**
 * All Chats is one friend, so the name the user gives it in the panel is the
 * name the sidebar heading says. This is the seam where that could go wrong:
 * the panel writes the record and the sidebar reads it.
 */

const CHATS_ROOT = '/home/user/.config/openchamber/chats';
const storage = () => {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};

test('the heading takes the name the user gave the All Chats friend', () => {
  const store = storage();
  const profiles = readFriendProfiles(store, 'local');
  saveFriendProfile(store, 'local', `folder:${CHATS_ROOT}`, {
    name: 'General (All Chats)',
    body: 'bean',
    color: 'success',
  }, profiles.revision);

  const saved = readFriendProfiles(store, 'local');
  expect(allChatsFriendName(saved, CHATS_ROOT)).toBe('General (All Chats)');
});

test('a folder that is not the chats root is not the All Chats friend', () => {
  const store = storage();
  const profiles = readFriendProfiles(store, 'local');
  saveFriendProfile(store, 'local', 'folder:/home/user/work/business launch', {
    name: 'Business Launch',
    body: 'blob',
    color: 'primary',
  }, profiles.revision);

  const saved = readFriendProfiles(store, 'local');
  expect(allChatsFriendName(saved, CHATS_ROOT)).toBeNull();
  expect(allChatsFriendName(saved, '/home/user/work/business launch')).toBe('Business Launch');
});

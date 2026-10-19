import { describe, expect, test } from 'bun:test';
import { friendName, readFriendProfiles, saveFriendName, readFriendLink, writeFriendLink } from './friends';

const storage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; };
describe('friend identity and scope', () => {
  test('uses familiar display names without creating or changing agent definitions', () => { expect(friendName(null, { name: 'manager', displayName: 'Manager' })).toBe('Milo'); expect(friendName(null, { name: 'custom', displayName: 'My researcher' })).toBe('My researcher'); });
  test('shares a name across folders while keeping it separate from another host', () => {
    const s = storage();
    saveFriendName(s, 'local', 'manager', 'Milo', 0);
    expect(readFriendProfiles(s, 'local').aliases).toEqual([{ agent: 'manager', name: 'Milo' }]);
    expect(readFriendProfiles(s, 'remote').aliases).toEqual([]);
    expect(() => saveFriendName(s, 'local', 'manager', 'Other', 0)).toThrow('another window');
  });
  test('never opens a saved conversation from a different folder or host', () => {
    const s = storage();
    writeFriendLink(s, 'local', '/legal', 'manager', { state: 'ready', sessionId: 'ses_legal' });
    expect(readFriendLink(s, 'local', '/legal', 'manager')).toEqual({ state: 'ready', sessionId: 'ses_legal' });
    expect(readFriendLink(s, 'local', '/personal', 'manager')).toBeNull();
    expect(readFriendLink(s, 'remote', '/legal', 'manager')).toBeNull();
  });
  test('preserves an ambiguous creation and refuses corrupt data instead of clearing it', () => {
    const s = storage();
    writeFriendLink(s, 'local', '/legal', 'manager', { state: 'creating' });
    expect(readFriendLink(s, 'local', '/legal', 'manager')).toEqual({ state: 'creating' });
    const broken = { getItem: () => '{broken', setItem: () => { throw new Error('Must not overwrite'); } };
    expect(() => readFriendProfiles(broken, 'local')).toThrow();
  });
});

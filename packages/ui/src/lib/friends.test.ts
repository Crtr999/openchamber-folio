import { describe, expect, test } from 'bun:test';
import { FRIEND_COLORS, FRIEND_BODIES, FriendRevisionConflict, defaultFriendAppearance, friendAppearance, friendName, readFriendProfiles, saveFriendProfile, readFriendLink, writeFriendLink } from './friends';

const storage = () => { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; };
const key = (runtime: string) => `open-carter:friends:v1:${JSON.stringify(runtime)}`;
const look = { body: 'ghost', color: 'keyword' } as const;
describe('friend identity and scope', () => {
  test('uses familiar display names without creating or changing agent definitions', () => { expect(friendName(null, { name: 'manager', displayName: 'Manager' })).toBe('Milo'); expect(friendName(null, { name: 'custom', displayName: 'My researcher' })).toBe('My researcher'); });
  test('shares a name and look across folders while keeping it separate from another host', () => {
    const s = storage();
    saveFriendProfile(s, 'local', 'manager', { name: 'Milo', ...look }, 0);
    expect(readFriendProfiles(s, 'local').friends).toEqual([{ agent: 'manager', name: 'Milo', ...look }]);
    expect(friendAppearance(readFriendProfiles(s, 'local'), 'manager')).toEqual(look);
    expect(readFriendProfiles(s, 'remote').friends).toEqual([]);
    expect(() => saveFriendProfile(s, 'local', 'manager', { name: 'Other', ...look }, 0)).toThrow(FriendRevisionConflict);
    expect(() => saveFriendProfile(s, 'local', 'manager', { name: 'Other', ...look }, 0)).toThrow('another window');
  });
  test('migrates version 1 names in memory, keeps the revision and writes version 2 only on save', () => {
    const s = storage();
    const legacy = JSON.stringify({ version: 1, revision: 4, aliases: [{ agent: 'build', name: 'Bolt' }, { agent: 'plan', name: 'Atlas' }, { agent: 'build', name: 'Shadowed' }] });
    s.values.set(key('local'), legacy);
    const migrated = readFriendProfiles(s, 'local');
    expect(migrated).toEqual({ version: 2, revision: 4, friends: [{ agent: 'build', name: 'Bolt' }, { agent: 'plan', name: 'Atlas' }] });
    expect(friendName(migrated, { name: 'build', displayName: 'Build' })).toBe('Bolt');
    expect(friendAppearance(migrated, 'plan')).toEqual(defaultFriendAppearance('plan'));
    expect(s.values.get(key('local'))).toBe(legacy);
    expect(() => saveFriendProfile(s, 'local', 'plan', { name: 'Atlas', ...look }, 3)).toThrow(FriendRevisionConflict);
    const saved = saveFriendProfile(s, 'local', 'plan', { name: 'Atlas', ...look }, 4);
    expect(saved.revision).toBe(5);
    expect(JSON.parse(s.values.get(key('local')) ?? 'null')).toEqual({ version: 2, revision: 5, friends: [{ agent: 'build', name: 'Bolt' }, { agent: 'plan', name: 'Atlas', ...look }] });
    expect(readFriendProfiles(s, 'local')).toEqual(saved);
  });
  test('rejects unknown looks, duplicate entries and invalid names without touching storage', () => {
    const s = storage();
    for (const record of [
      { version: 2, revision: 1, friends: [{ agent: 'build', body: 'triangle' }] },
      { version: 2, revision: 1, friends: [{ agent: 'build', color: '#ff0000' }] },
      { version: 2, revision: 1, friends: [{ agent: 'build', name: 'A' }, { agent: 'build', name: 'B' }] },
      { version: 3, revision: 1, friends: [] },
    ]) {
      s.values.set(key('local'), JSON.stringify(record));
      expect(() => readFriendProfiles(s, 'local')).toThrow();
      expect(() => saveFriendProfile(s, 'local', 'build', { name: 'Pip', ...look }, 1)).toThrow();
      expect(s.values.get(key('local'))).toBe(JSON.stringify(record));
    }
    const empty = storage();
    expect(() => saveFriendProfile(empty, 'local', 'build', { name: '   ', ...look }, 0)).toThrow();
    expect(() => saveFriendProfile(empty, 'local', 'build', { name: 'x'.repeat(33), ...look }, 0)).toThrow();
    expect(empty.values.size).toBe(0);
  });
  test('default looks are deterministic, valid and keep Build on its identity color', () => {
    expect(defaultFriendAppearance('explore')).toEqual(defaultFriendAppearance('explore'));
    expect(defaultFriendAppearance('build').color).toBe('success');
    for (const agent of ['build', 'general', 'explore', 'plan', 'browser', 'manager', 'operator', 'zdr', 'business-reader']) {
      const { body, color } = defaultFriendAppearance(agent);
      expect(FRIEND_BODIES).toContain(body);
      expect(FRIEND_COLORS).toContain(color);
      if (agent !== 'build') expect(color).not.toBe('success');
    }
    expect(new Set(['general', 'explore', 'plan', 'browser', 'manager', 'operator'].map(agent => defaultFriendAppearance(agent).body)).size).toBeGreaterThan(2);
  });
  test('a failed write leaves the previous record and revision in place', () => {
    const s = storage();
    saveFriendProfile(s, 'local', 'build', { name: 'Pip', ...look }, 0);
    const before = s.values.get(key('local'));
    const failing = { getItem: s.getItem, setItem: () => { throw new Error('Quota exceeded'); } };
    expect(() => saveFriendProfile(failing, 'local', 'build', { name: 'Bolt', ...look }, 1)).toThrow('Quota exceeded');
    expect(s.values.get(key('local'))).toBe(before);
    expect(readFriendProfiles(s, 'local').revision).toBe(1);
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

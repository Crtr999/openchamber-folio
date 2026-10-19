import { expect, test } from 'bun:test';
import { friendsI18n } from './friends.i18n';

test('Friends copy exists with the same keys in every shipped language', () => {
  for (const [locale, messages] of Object.entries(friendsI18n)) {
    expect(Object.keys(messages).sort()).toEqual(Object.keys(friendsI18n.en).sort());
    for (const value of Object.values(messages)) expect(value.length).toBeGreaterThan(0);
    if (locale !== 'en') expect(messages['friends.customizeDescription']).not.toBe(friendsI18n.en['friends.customizeDescription']);
    expect(messages['friends.openChat']).toContain('{name}');
    expect(messages['friends.status.active']).toContain('{time}');
  }
});

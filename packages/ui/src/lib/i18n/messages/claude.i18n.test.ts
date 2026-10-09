import { expect, test } from 'bun:test';
import { claudeI18n } from './claude.i18n';

test('Claude controls and history fallback exist in all shipped languages', () => {
  expect(Object.keys(claudeI18n).length).toBe(13);
  for (const [locale, messages] of Object.entries(claudeI18n)) {
    expect(Object.keys(messages)).toEqual(Object.keys(claudeI18n.en));
    expect(messages['claude.full'].length).toBeGreaterThan(0);
    if (locale !== 'en') expect(messages['claude.historyUnavailable']).not.toBe(claudeI18n.en['claude.historyUnavailable']);
  }
});

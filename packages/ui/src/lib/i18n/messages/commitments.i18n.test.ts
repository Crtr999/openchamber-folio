import { expect, test } from 'bun:test';
import { commitmentsI18n } from './commitments.i18n';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

test('Commitments copy has the same keys and placeholders in every shipped language', () => {
  const english = commitmentsI18n.en as Record<string, string>;
  expect(Object.keys(commitmentsI18n).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'ko', 'nl', 'pl', 'pt-BR', 'tr', 'uk', 'zh-CN', 'zh-TW']);
  for (const [locale, messages] of Object.entries(commitmentsI18n) as Array<[string, Record<string, string>]>) {
    expect(Object.keys(messages).sort()).toEqual(Object.keys(english).sort());
    for (const [key, value] of Object.entries(messages)) {
      expect(value.length).toBeGreaterThan(0);
      expect(placeholders(value)).toEqual(placeholders(english[key]));
      // A translation is never the English text pasted in, except for the
      // few words that are the same word in that language.
      if (locale !== 'en' && value === english[key]) expect(['commitments.title', 'commitments.settings.title']).not.toContain(key);
    }
  }
});

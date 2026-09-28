import { describe, expect, test } from 'bun:test';
import { folioI18n } from './folio.i18n';

const locales = ['en', 'de', 'fr', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr'] as const;

/** The Ask AI keys this change added, plus the placeholder it widened. */
const requiredKeys = [
  'folio.askModel',
  'folio.askVariantNone',
  'folio.askThinkingLevel',
  'folio.askGroupPages',
  'folio.askGroupChats',
  'folio.askGroupFiles',
  'folio.askGroupSkills',
  'folio.askNoMatches',
  'folio.askMention',
  'folio.askFailedReason',
  'folio.askSessionFailed',
  'folio.askPlaceholder',
] as const;

const english = folioI18n.en;

describe('Ask AI translations', () => {
  test('provides every key in every supported locale', () => {
    for (const locale of locales) {
      for (const key of requiredKeys) {
        expect(folioI18n[locale][key]).toBeTruthy();
      }
    }
  });

  test('translates each one rather than leaving the English text in place', () => {
    // "Model", "Default", "Chat" and "Pages" are the correct words in a few
    // languages, so only the keys that carry real wording are held to this.
    const alsoEnglish = new Set<string>(['folio.askModel', 'folio.askVariantNone', 'folio.askGroupPages', 'folio.askGroupChats', 'folio.askGroupFiles']);
    for (const locale of locales) {
      for (const key of requiredKeys) {
        if (locale === 'en' || alsoEnglish.has(key)) continue;
        expect(folioI18n[locale][key]).not.toBe(english[key]);
      }
    }
  });

  test('keeps the reason a turn failed in the sentence, not only in English', () => {
    for (const locale of locales) {
      expect(folioI18n[locale]['folio.askFailedReason']).toContain('{reason}');
    }
  });

  test('keeps the thinking level in the label, in every locale', () => {
    for (const locale of locales) {
      expect(folioI18n[locale]['folio.askThinkingLevel']).toContain('{level}');
    }
  });
});

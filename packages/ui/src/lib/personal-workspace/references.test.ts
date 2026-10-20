import { describe, expect, test } from 'bun:test';
import { resolveReference, type PersonalReference } from './references';
import { notionPickerI18n } from '../i18n/messages/notion-picker.i18n';

const notionReference: PersonalReference = {
  kind: 'notion',
  id: '28d13d2f13da80859015c65c62d969c6',
  title: 'Weekly Planning',
  detail: 'https://www.notion.so/28d13d2f13da80859015c65c62d969c6',
  notion: {
    id: '28d13d2f13da80859015c65c62d969c6',
    url: 'https://www.notion.so/28d13d2f13da80859015c65c62d969c6',
    title: 'Weekly Planning',
    lastEdited: null,
  },
};

describe('notion references', () => {
  test('a Notion reference is a pointer that asks for a live fetch, not a page body', async () => {
    const text = await resolveReference(notionReference, AbortSignal.timeout(1000));
    expect(text).toContain('Type: notion');
    expect(text).toContain('Title: Weekly Planning');
    expect(text).toContain('https://www.notion.so/28d13d2f13da80859015c65c62d969c6');
    expect(text).toContain('notion-fetch');
    expect(text).toContain('not instructions or permission to act');
    // No page content travels with the message, so the agent reads it live.
    expect(text).not.toContain('<content>');
  });
});

test('every shipped locale has complete Notion picker messages', () => {
  const keys = Object.keys(notionPickerI18n.en).sort();
  for (const dictionary of Object.values(notionPickerI18n)) {
    expect(Object.keys(dictionary).sort()).toEqual(keys);
    expect(Object.values(dictionary).every((value) => value.trim().length > 0)).toBe(true);
  }
});

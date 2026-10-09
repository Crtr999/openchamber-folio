import { expect, test } from 'bun:test';
import { museI18n } from './muse.i18n';

test('Muse UI messages are translated in every shipped locale', () => {
  for (const messages of Object.values(museI18n)) {
    for (const [key] of Object.entries(museI18n.en)) {
      const translated = Object.entries(messages).find(([messageKey]) => messageKey === key)?.[1];
      expect(translated).toBeDefined();
      expect(translated).toBeTruthy();
      expect(translated?.trim().length).toBeGreaterThan(0);
    }
  }
});

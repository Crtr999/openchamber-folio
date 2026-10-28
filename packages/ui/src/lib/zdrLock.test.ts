import { expect, test } from 'bun:test';
import { isPathGuarded } from './zdrLock';

const guarded = ['/Users/me/Docs/ZDR Management'];

test('a guarded folder and everything inside it is guarded, nothing else', () => {
  expect(isPathGuarded(guarded, '/Users/me/Docs/ZDR Management')).toBe(true);
  expect(isPathGuarded(guarded, '/Users/me/Docs/ZDR Management/cases/a.md')).toBe(true);
  expect(isPathGuarded(guarded, '/Users/me/Docs/ZDR Management/')).toBe(true);
  expect(isPathGuarded(guarded, '/Users/me/Docs/ZDR Management Archive')).toBe(false);
  expect(isPathGuarded(guarded, '/Users/me/Docs/Legal')).toBe(false);
  expect(isPathGuarded(guarded, null)).toBe(false);
  expect(isPathGuarded([], '/Users/me/Docs/ZDR Management')).toBe(false);
});

import { afterEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createZdrLock } from './runtime.js';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const make = (clock = { t: 1_000_000 }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zdr-lock-'));
  dirs.push(dir);
  const file = path.join(dir, 'zdr-lock.json');
  return { file, clock, lock: createZdrLock({ file, now: () => clock.t }) };
};

test('no PIN set means nothing is guarded', () => {
  const { lock } = make();
  expect(lock.isSet()).toBe(false);
  expect(lock.verify('1234').ok).toBe(true);
});

test('only four digits are accepted, and only a salted hash is stored', () => {
  const { lock, file } = make();
  expect(lock.set('12a4').ok).toBe(false);
  expect(lock.set('123').ok).toBe(false);
  expect(lock.set('4821').ok).toBe(true);
  const stored = fs.readFileSync(file, 'utf8');
  expect(stored).not.toContain('4821');
  expect(JSON.parse(stored).salt).toHaveLength(32);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(lock.verify('4821').ok).toBe(true);
  expect(lock.verify('4822').ok).toBe(false);
});

test('repeated wrong guesses lock the check out, even for the right PIN, then it recovers', () => {
  const { lock, clock } = make();
  lock.set('4821');
  for (let i = 0; i < 4; i += 1) expect(lock.verify('0000').retryAfterMs).toBe(0);
  const fifth = lock.verify('0000');
  expect(fifth.ok).toBe(false); expect(fifth.retryAfterMs).toBeGreaterThan(0);
  expect(lock.verify('4821').ok).toBe(false);
  clock.t += 31_000;
  expect(lock.verify('4821').ok).toBe(true);
});

test('changing or removing the PIN needs the current one', () => {
  const { lock } = make();
  lock.set('4821');
  expect(lock.set('9999', '1111').ok).toBe(false);
  expect(lock.set('9999', '4821').ok).toBe(true);
  expect(lock.clear('4821').ok).toBe(false);
  expect(lock.clear('9999').ok).toBe(true);
  expect(lock.isSet()).toBe(false);
});

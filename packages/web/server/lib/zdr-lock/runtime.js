/**
 * A four-digit PIN in front of ZDR folders.
 *
 * The PIN is checked here, never in the page. Only a salted PBKDF2 hash is kept, and repeated
 * wrong guesses lock the check out for a growing wait. This is a lock against someone using the
 * open app, not encryption of the folder's files on disk.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ITERATIONS = 210_000;
const KEY_LENGTH = 32;
const FREE_ATTEMPTS = 5;
const BASE_WAIT_MS = 30_000;
const MAX_WAIT_MS = 15 * 60_000;

export const isValidPin = (value) => typeof value === 'string' && /^\d{4}$/.test(value);

const derive = (pin, salt) => crypto.pbkdf2Sync(pin, salt, ITERATIONS, KEY_LENGTH, 'sha256');

export const createZdrLock = ({ file, now = Date.now }) => {
  const grants = new Map();
  const grant = () => {
    const accessToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = now() + 10 * 60_000;
    for (const [token, expires] of grants) if (expires <= now()) grants.delete(token);
    grants.set(accessToken, expiresAt);
    return { accessToken, expiresAt };
  };
  const read = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (/^[0-9a-f]{32}$/i.test(parsed?.salt) && /^[0-9a-f]{64}$/i.test(parsed?.hash)) {
        return { salt: parsed.salt, hash: parsed.hash, failures: Number(parsed.failures) || 0, blockedUntil: Number(parsed.blockedUntil) || 0 };
      }
      throw new Error('Invalid lock record');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('Lock record unavailable');
    }
  };
  const write = (record) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temp, file);
  };

  const matches = (record, pin) => {
    const expected = Buffer.from(record.hash, 'hex');
    const actual = derive(pin, Buffer.from(record.salt, 'hex'));
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  };

  return {
    isSet: () => read() !== null,
    isAuthorized: (token) => (grants.get(token) ?? 0) > now(),
    revoke: (token) => { grants.delete(token); },
    retryAfterMs: () => {
      const record = read();
      return record ? Math.max(0, record.blockedUntil - now()) : 0;
    },
    /** True only for the right PIN; a wrong one counts toward the lockout. */
    verify(pin) {
      const record = read();
      if (!record) return { ok: true, retryAfterMs: 0 };
      const wait = Math.max(0, record.blockedUntil - now());
      if (wait > 0) return { ok: false, retryAfterMs: wait };
      if (isValidPin(pin) && matches(record, pin)) {
        if (record.failures || record.blockedUntil) write({ ...record, failures: 0, blockedUntil: 0 });
        return { ok: true, retryAfterMs: 0, ...grant() };
      }
      const failures = record.failures + 1;
      const blockedUntil = failures >= FREE_ATTEMPTS ? now() + Math.min(MAX_WAIT_MS, BASE_WAIT_MS * 2 ** (failures - FREE_ATTEMPTS)) : 0;
      write({ ...record, failures, blockedUntil });
      return { ok: false, retryAfterMs: Math.max(0, blockedUntil - now()) };
    },
    /** Sets or changes the PIN. Changing an existing one needs the current PIN. */
    set(pin, currentPin) {
      if (!isValidPin(pin)) return { ok: false, error: 'The PIN must be exactly four digits.' };
      if (read()) {
        const check = this.verify(currentPin);
        if (!check.ok) return { ok: false, error: 'The current PIN is wrong.', retryAfterMs: check.retryAfterMs };
      }
      const salt = crypto.randomBytes(16);
      write({ salt: salt.toString('hex'), hash: derive(pin, salt).toString('hex'), failures: 0, blockedUntil: 0 });
      grants.clear();
      return { ok: true, ...grant() };
    },
    clear(pin) {
      if (!read()) return { ok: true };
      const check = this.verify(pin);
      if (!check.ok) return { ok: false, error: 'The PIN is wrong.', retryAfterMs: check.retryAfterMs };
      try { fs.rmSync(file, { force: true }); } catch { return { ok: false, error: 'The PIN could not be removed.' }; }
      grants.clear();
      return { ok: true };
    },
  };
};

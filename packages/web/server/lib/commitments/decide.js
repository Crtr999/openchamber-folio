import { createHash } from 'node:crypto';
import { findThreatPattern } from '../agent-memory/threat-patterns.js';

export const QUIET_TOKEN = '[CARTER_NO_UPDATE]';
export const MESSAGE_LIMIT = 280;

const normalize = (text) => text.toLowerCase().replace(/\s+/g, ' ').trim();
export const fingerprintOf = (text) => createHash('sha256').update(normalize(text)).digest('hex').slice(0, 32);

const plain = (text) => text
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/[*_`#>]+/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const clip = (text) => {
  if (text.length <= MESSAGE_LIMIT) return text;
  const cut = text.slice(0, MESSAGE_LIMIT - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 200))}…`;
};

/**
 * The worth-interrupting rule, applied to a check's final reply.
 *
 * The model is asked to stay quiet unless there is something new, but the
 * decision is made here: an empty reply, a hedged one, a repeat of the last
 * message or text that reads like an injected instruction never reaches the
 * user.
 */
export const decideNudge = ({ reply, item }) => {
  const raw = typeof reply === 'string' ? reply.trim() : '';
  if (!raw) return { kind: 'quiet', reason: 'empty' };
  if (raw.includes(QUIET_TOKEN)) return { kind: 'quiet', reason: 'nothing-new' };
  const message = clip(plain(raw));
  if (!message) return { kind: 'quiet', reason: 'empty' };
  if (findThreatPattern(message)) return { kind: 'quiet', reason: 'suspicious' };
  const fingerprint = fingerprintOf(message);
  if (fingerprint === item.findingFingerprint) return { kind: 'quiet', reason: 'repeat' };
  return { kind: 'nudge', message, fingerprint };
};

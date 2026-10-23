import { DateTime } from 'luxon';
import { z } from 'zod';
import { findThreatPattern } from '../agent-memory/threat-patterns.js';

const MAX_PROMPT_CHARS = 24_000;
const MAX_PER_CAPTURE = 3;
// A date this far in the past is a misread, not something still owed.
const STALE_MS = 24 * 3_600_000;

export const buildExtractionSystemPrompt = ({ now, timezone }) => {
  const today = DateTime.fromMillis(now, { zone: timezone });
  return [
    'You find commitments with a date in a conversation, for a personal deadline tracker.',
    `Today is ${today.toFormat('cccc, yyyy-LL-dd')} and the user\'s time zone is ${timezone}. Resolve relative dates like "Friday" or "next week" against it.`,
    'A commitment is something the USER personally owes or is waiting on, with a date: a paper or assignment due, an application deadline, a form to file, a product release they plan to buy, an appointment to prepare for.',
    'Not a commitment: a topic they are only discussing, work the assistant just finished, hypotheticals, dates inside documents they are only reading, or anything that has no date and no condition to watch.',
    'Return exactly one JSON object and nothing else: {"commitments": [{"title": "...", "due": "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" or null, "watches": ["..."], "notes": "...", "research": true}]}.',
    'title is short and plain, under 80 characters. due is null only when the user wants a condition watched without a date.',
    'notes is under 200 characters: what the user said they want, like or care about for this commitment (scope, format, preferences, how they want to be helped) plus any key detail that would matter when reminding them later. Use their own preferences, not your advice. Empty string when there is none.',
    'Something the user says they want to buy or get (a phone, a ticket, a book) is a commitment too, even with no date: title it "Buy <thing>" and put what a helpful friend would watch in watches, such as "price drops and sales", "stock and availability", or "release date". Use the release date as due when one is known.',
    'Otherwise watches holds a condition only if the user asked to keep an eye on it, such as "same-day pickup availability". Leave it empty when there is none.',
    'Set research to false for anything that looks like work, a legal or client matter, or anything private or confidential: those are counted down but never searched for on the web. When unsure, use false.',
    'Never include a secret, an account or ID number, or the names of clients or parties in a title or watch.',
    'Return {"commitments": []} when there is nothing. That is a good answer.',
  ].join('\n');
};

export const buildExtractionPrompt = (turns, charBudget) => {
  const budget = Math.min(MAX_PROMPT_CHARS, Math.floor(charBudget));
  if (!Number.isFinite(budget) || budget < 1_000 || !turns.length) return null;
  const footer = '\n\n--- End of conversation ---\n\nReturn the dated commitments the user has, as JSON.';
  let body = '';
  for (const [index, turn] of [...turns].reverse().entries()) {
    const text = `Turn ${turns.length - index}\nUser message:\n${turn.user?.text ?? ''}\nAssistant response:\n${turn.assistant?.text ?? ''}\n\n`;
    if (body.length + text.length + footer.length > budget) break;
    body = text + body;
  }
  return body ? `Conversation turns, oldest first.\n\n${body}${footer}` : null;
};

const entrySchema = z.object({
  title: z.string().trim().min(1).max(160),
  due: z.string().trim().nullable().optional(),
  watches: z.array(z.string().trim().min(1).max(200)).max(3).optional(),
  notes: z.string().trim().max(400).optional(),
  research: z.boolean().optional(),
});

const readJson = (text) => {
  if (typeof text !== 'string') return null;
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
};

const toEpoch = (due, timezone) => {
  if (!due) return null;
  // A date with no time is due at the end of that day.
  const parsed = DateTime.fromISO(due, { zone: timezone });
  if (!parsed.isValid) return undefined;
  return (due.includes('T') ? parsed : parsed.set({ hour: 23, minute: 59 })).toMillis();
};

/** Entries that survive validation. Anything doubtful is dropped, never repaired. */
export const parseExtraction = (text, { now, timezone }) => {
  const root = readJson(text);
  const list = Array.isArray(root?.commitments) ? root.commitments : [];
  const found = [];
  for (const candidate of list) {
    const entry = entrySchema.safeParse(candidate);
    if (!entry.success) continue;
    const watches = entry.data.watches ?? [];
    const notes = (entry.data.notes ?? '').slice(0, 300);
    if (findThreatPattern([entry.data.title, ...watches, notes].join('\n'))) continue;
    const dueAt = toEpoch(entry.data.due, timezone);
    if (dueAt === undefined) continue;
    if (dueAt === null && watches.length === 0) continue;
    if (dueAt !== null && dueAt < now - STALE_MS) continue;
    found.push({ title: entry.data.title, dueAt, watches, notes, research: entry.data.research !== false });
    if (found.length >= MAX_PER_CAPTURE) break;
  }
  return found;
};

const tokens = (title) => new Set(title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((word) => word.length > 2));

/** Whether a candidate restates something already tracked, finished or removed. */
export const isDuplicate = (candidate, items) => {
  const wanted = tokens(candidate.title);
  return items.some((item) => {
    const have = tokens(item.title);
    if (!wanted.size || !have.size) return item.title.toLowerCase() === candidate.title.toLowerCase();
    const shared = [...wanted].filter((word) => have.has(word)).length;
    const overlap = shared / new Set([...wanted, ...have]).size;
    const sameDay = item.dueAt == null || candidate.dueAt == null || Math.abs(item.dueAt - candidate.dueAt) <= 24 * 3_600_000;
    return overlap >= 0.6 && sameDay;
  });
};

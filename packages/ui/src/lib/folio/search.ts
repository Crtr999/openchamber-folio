import type { FolioNote } from './schema';

export interface Hit { blockID: string; before: string; match: string; after: string }

/** The block that explains why a page matched, trimmed to a short line around the match. */
export function findHit(note: FolioNote, query: string): Hit | undefined {
  const needle = query.toLowerCase();
  const words = needle.split(/\s+/).filter((word) => word.length > 1);
  let best: { blockID: string; text: string; at: number; length: number; score: number } | undefined;
  for (const block of note.blocks) {
    const lower = block.text.toLowerCase();
    const at = lower.indexOf(needle);
    if (at >= 0) { best = { blockID: block.id, text: block.text, at, length: needle.length, score: Infinity }; break; }
    const score = words.filter((word) => lower.includes(word)).length;
    if (score && (!best || score > best.score)) {
      const first = words.find((word) => lower.includes(word)) ?? '';
      best = { blockID: block.id, text: block.text, at: lower.indexOf(first), length: first.length, score };
    }
  }
  if (!best) return undefined;
  let start = Math.max(0, best.at - 36);
  if (start > 0) { const space = best.text.indexOf(' ', start); if (space >= 0 && space < best.at) start = space + 1; }
  const end = Math.min(best.text.length, best.at + best.length + 80);
  return { blockID: best.blockID, before: (start > 0 ? '…' : '') + best.text.slice(start, best.at), match: best.text.slice(best.at, best.at + best.length), after: best.text.slice(best.at + best.length, end) + (end < best.text.length ? '…' : '') };
}


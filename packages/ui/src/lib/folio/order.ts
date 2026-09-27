import type { FolioNote } from './schema';

/**
 * Page order among siblings. Pages the user has dragged carry an `order`; the rest keep the
 * order they arrive in, after the ordered ones. Shared by the Mac sidebar and the iPhone tree.
 */
export function sortSiblings(notes: readonly FolioNote[]): FolioNote[] {
  const ordered = notes.filter((n) => n.order !== undefined).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return [...ordered, ...notes.filter((n) => n.order === undefined)];
}

/** Moves one page to another's place among the same siblings; returns the pages whose order changed. */
export function reorderSiblings(siblings: readonly FolioNote[], movedID: string, targetID: string): FolioNote[] {
  const list = sortSiblings(siblings);
  const from = list.findIndex((n) => n.id === movedID);
  const to = list.findIndex((n) => n.id === targetID);
  if (from < 0 || to < 0 || from === to) return [];
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  return list.flatMap((note, index) => (note.order === index ? [] : [{ ...note, order: index }]));
}

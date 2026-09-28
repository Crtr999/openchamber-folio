import type { FolioNote } from './schema';

/**
 * Page order among siblings. Pages the user has dragged carry an `order`; the rest keep the
 * order they arrive in, after the ordered ones. Shared by the Mac sidebar and the iPhone tree.
 */
export function sortSiblings(notes: readonly FolioNote[]): FolioNote[] {
  const ordered = notes.filter((n) => n.order !== undefined).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return [...ordered, ...notes.filter((n) => n.order === undefined)];
}

/** The pages of a list numbered 0 to n in the order they read, so `sortSiblings` reads them back that way. */
function renumbered(list: readonly FolioNote[]): FolioNote[] {
  return list.flatMap((note, index) => (note.order === index ? [] : [{ ...note, order: index }]));
}

/** Moves one page to another's place among the same siblings; returns the pages whose order changed. */
export function reorderSiblings(siblings: readonly FolioNote[], movedID: string, targetID: string): FolioNote[] {
  const list = sortSiblings(siblings);
  const from = list.findIndex((n) => n.id === movedID);
  const to = list.findIndex((n) => n.id === targetID);
  if (from < 0 || to < 0 || from === to) return [];
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  return renumbered(list);
}

/** Where a released page lands on the row underneath: beside it, or inside it. */
export type DropZone = 'before' | 'inside' | 'after';

/**
 * Which of the three places on a row the pointer is over. The outer quarters put the page next to the
 * row and the middle half puts it inside, Notion's split, so one drag does both without a modifier key.
 * A row with no measured height has no quarters, so all of it counts as the middle.
 */
export function dropZoneAt(offsetY: number, height: number): DropZone {
  if (!(height > 0)) return 'inside';
  if (offsetY < height * 0.25) return 'before';
  if (offsetY > height * 0.75) return 'after';
  return 'inside';
}

/** Where every page hangs, with a parent that is not in the notebook reading as no parent at all. */
function parentKeys(notes: readonly FolioNote[]): Map<string, string> {
  const present = new Set(notes.map((note) => note.id));
  return new Map(notes.map((note) => [note.id, note.parentID && present.has(note.parentID) ? note.parentID : '']));
}

/**
 * Whether a page sits somewhere under another, which is what makes it untouchable as a target for that
 * page: a page inside its own pages would take them out of the notebook with it. The walk stops on a
 * repeat, so a parent cycle already in the data ends the walk instead of hanging it.
 */
export function isUnder(notes: readonly FolioNote[], ancestorID: string, pageID: string): boolean {
  const parents = parentKeys(notes);
  const walked = new Set<string>();
  for (let id = parents.get(pageID); id && !walked.has(id); id = parents.get(id)) {
    if (id === ancestorID) return true;
    walked.add(id);
  }
  return false;
}

/**
 * The pages a drop rewrites, or nothing when the drop cannot happen: a page never lands inside itself or
 * inside one of its own pages, the two edges only reorder among the target's own siblings, and a page that
 * is already in the target has nothing to move. A page dropped inside another lands after the pages
 * already in there, and its own pages come along untouched, because they still point at it.
 */
export function dropPages(notes: readonly FolioNote[], movedID: string, targetID: string, zone: DropZone): FolioNote[] {
  if (movedID === targetID) return [];
  const moved = notes.find((note) => note.id === movedID);
  const target = notes.find((note) => note.id === targetID);
  if (!moved || !target) return [];
  if (zone === 'inside') {
    if (moved.parentID === targetID || isUnder(notes, movedID, targetID)) return [];
    // The pages already in there are numbered along with the one arriving, because a page the user has
    // never dragged carries no order to be placed after and would otherwise read as the last one.
    return renumbered([...sortSiblings(notes.filter((note) => note.parentID === targetID)), { ...moved, parentID: targetID }]);
  }
  const parents = parentKeys(notes);
  const key = parents.get(movedID) ?? '';
  if (key !== (parents.get(targetID) ?? '')) return [];
  return reorderSiblings(notes.filter((note) => (parents.get(note.id) ?? '') === key), movedID, targetID);
}

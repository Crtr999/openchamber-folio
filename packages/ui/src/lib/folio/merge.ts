import type { FolioBlock, FolioNote } from './schema';

const same = <T,>(a: T, b: T): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Three-way merge of one page, for a save whose base moved underneath it (the AI edited the page,
 * or a sync landed, while an edit here was still unsaved). `base` is the page the edit started from,
 * `mine` the edit, `theirs` the latest saved page.
 *
 * Whatever this edit changed wins; everything it left alone takes the latest version. Blocks are
 * matched by id, so an edit to one line never undoes another writer's lines, and new lines from
 * both sides are kept in order.
 */
export function mergeNote(base: FolioNote, mine: FolioNote, theirs: FolioNote): FolioNote {
  const pick = <K extends keyof FolioNote>(key: K): FolioNote[K] => (same(mine[key], base[key]) ? theirs[key] : mine[key]);
  const baseBlocks = new Map(base.blocks.map((block) => [block.id, block]));
  const mineBlocks = new Map(mine.blocks.map((block) => [block.id, block]));
  const theirIDs = new Set(theirs.blocks.map((block) => block.id));

  const blocks: FolioBlock[] = [];
  for (const block of theirs.blocks) {
    const original = baseBlocks.get(block.id);
    const edited = mineBlocks.get(block.id);
    if (original && !edited) {
      // Deleted here: stays deleted unless the other side changed it meanwhile.
      if (!same(block, original)) blocks.push(block);
      continue;
    }
    blocks.push(edited && original && !same(edited, original) ? edited : block);
  }
  // Lines added here go after the line they followed in this edit.
  mine.blocks.forEach((block, index) => {
    if (baseBlocks.has(block.id) || theirIDs.has(block.id)) return;
    let at = 0;
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      const found = blocks.findIndex((candidate) => candidate.id === mine.blocks[previous].id);
      if (found >= 0) { at = found + 1; break; }
    }
    blocks.splice(at, 0, block);
  });

  return {
    ...theirs,
    title: pick('title'), icon: pick('icon'), tags: pick('tags'), favorite: pick('favorite'),
    parentID: pick('parentID'), excludedFromAI: pick('excludedFromAI'), order: pick('order'), table: pick('table'),
    blocks: blocks.length ? blocks : theirs.blocks,
  };
}

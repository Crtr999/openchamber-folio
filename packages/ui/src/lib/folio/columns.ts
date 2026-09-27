import type { FolioBlock } from './schema';

/**
 * Side-by-side blocks, like Notion's columns. Blocks stay one flat list: blocks that share a `row`
 * id sit next to each other, split into columns by `column` (0, 1, 2…). A row's blocks are always
 * contiguous and ordered column by column, so reading the page top to bottom (the phone, exports,
 * the AI) still gets every line in a sensible order.
 */

export type PageSegment =
  | { kind: 'block'; block: FolioBlock; index: number }
  | { kind: 'row'; row: string; columns: Array<Array<{ block: FolioBlock; index: number }>> };

/** The page as the editor draws it: single blocks and rows of columns. */
export function pageSegments(blocks: readonly FolioBlock[]): PageSegment[] {
  const segments: PageSegment[] = [];
  blocks.forEach((block, index) => {
    const last = segments.at(-1);
    if (!block.row) { segments.push({ kind: 'block', block, index }); return; }
    if (last?.kind === 'row' && last.row === block.row) {
      const column = block.column ?? 0;
      while (last.columns.length <= column) last.columns.push([]);
      last.columns[column].push({ block, index });
      return;
    }
    const columns: Array<Array<{ block: FolioBlock; index: number }>> = [];
    const column = block.column ?? 0;
    while (columns.length <= column) columns.push([]);
    columns[column].push({ block, index });
    segments.push({ kind: 'row', row: block.row, columns });
  });
  // Empty column slots (a gap in the numbering) are dropped.
  for (const segment of segments) if (segment.kind === 'row') segment.columns = segment.columns.filter((c) => c.length > 0);
  return segments;
}

const plain = (block: FolioBlock): FolioBlock => {
  const rest = { ...block };
  delete rest.row;
  delete rest.column;
  return rest;
};

/**
 * Keeps rows well-formed after any move: each row contiguous and column-ordered, columns numbered
 * 0…n-1, and a row left with a single column turned back into ordinary blocks.
 */
export function normalizeRows(blocks: readonly FolioBlock[]): FolioBlock[] {
  const out: FolioBlock[] = [];
  const done = new Set<string>();
  for (const block of blocks) {
    if (!block.row) { out.push(block); continue; }
    if (done.has(block.row)) continue;
    done.add(block.row);
    const members = blocks.filter((b) => b.row === block.row);
    const used = [...new Set(members.map((b) => b.column ?? 0))].sort((a, b) => a - b);
    if (used.length < 2) { out.push(...members.map(plain)); continue; }
    for (const [position, column] of used.entries()) {
      for (const member of members) if ((member.column ?? 0) === column) out.push({ ...member, column: position });
    }
  }
  return out;
}

/** The block and the lines nested under it (deeper indent, same column), which move together. */
function span(blocks: readonly FolioBlock[], from: number): number {
  const head = blocks[from];
  let end = from + 1;
  while (end < blocks.length && (blocks[end].indent ?? 0) > (head.indent ?? 0) && blocks[end].row === head.row && blocks[end].column === head.column) end += 1;
  return end;
}

/** Moves a block (with its nested lines) so it sits before `before` (an index in `blocks`), joining the column it lands in. */
export function moveBlockBefore(blocks: readonly FolioBlock[], id: string, before: number): FolioBlock[] {
  const from = blocks.findIndex((b) => b.id === id);
  if (from < 0) return [...blocks];
  const end = span(blocks, from);
  if (before >= from && before <= end) return [...blocks];
  // It lands in the column of the block it is dropped in front of, or of the block above when dropped at a column's end.
  const below = blocks[before], above = blocks[before - 1];
  const host = below?.row ? below : above?.row && above.row === below?.row ? above : undefined;
  const moving = blocks.slice(from, end).map((b) => (host ? { ...b, row: host.row, column: host.column } : plain(b)));
  const rest = [...blocks.slice(0, from), ...blocks.slice(end)];
  const at = before > from ? before - (end - from) : before;
  return normalizeRows([...rest.slice(0, at), ...moving, ...rest.slice(at)]);
}

/** Drops a block beside another, making (or widening) a row of columns, like dragging to a block's edge in Notion. */
export function moveBlockBeside(blocks: readonly FolioBlock[], id: string, targetID: string, side: 'left' | 'right', newRowID: () => string): FolioBlock[] {
  if (id === targetID) return [...blocks];
  const from = blocks.findIndex((b) => b.id === id);
  if (from < 0 || !blocks.some((b) => b.id === targetID)) return [...blocks];
  const end = span(blocks, from);
  const movingIDs = new Set(blocks.slice(from, end).map((b) => b.id));
  if (movingIDs.has(targetID)) return [...blocks];
  let rest = [...blocks.slice(0, from), ...blocks.slice(end)];
  const target = rest.find((b) => b.id === targetID);
  if (!target) return [...blocks];
  const row = target.row ?? newRowID();
  const targetColumn = target.row ? target.column ?? 0 : 0;
  const column = side === 'right' ? targetColumn + 1 : targetColumn;
  // Make room: columns at or after the new one shift right.
  rest = rest.map((b) => {
    if (b.id === targetID && !target.row) return { ...b, row, column: side === 'right' ? 0 : 1 };
    if (b.row === row && (b.column ?? 0) >= column) return { ...b, column: (b.column ?? 0) + 1 };
    return b;
  });
  const moving = blocks.slice(from, end).map((b) => ({ ...b, row, column }));
  // Placed after the row's last block; normalizing then orders the row column by column.
  let last = -1;
  rest.forEach((b, index) => { if (b.row === row) last = index; });
  return normalizeRows([...rest.slice(0, last + 1), ...moving, ...rest.slice(last + 1)]);
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveBlockBefore, moveBlockBeside, pageSegments } from './columns';
import { makeBlock, type FolioBlock } from './schema';

const line = (text: string, extra: Partial<FolioBlock> = {}): FolioBlock => ({ ...makeBlock(), text, ...extra });
const layout = (blocks: FolioBlock[]) => pageSegments(blocks).map((s) => s.kind === 'block' ? s.block.text : s.columns.map((c) => c.map((x) => x.block.text).join('+')).join(' | '));

test('dragging a block to the right edge of another puts them side by side', () => {
  const [a, b, c] = [line('A'), line('B'), line('C')];
  const next = moveBlockBeside([a, b, c], c.id, a.id, 'right', () => 'row1');
  assert.deepEqual(layout(next), ['A | C', 'B']);
});

test('a third column goes where it is dropped, and the row stays together', () => {
  const [a, b, c] = [line('A'), line('B'), line('C')];
  let blocks = moveBlockBeside([a, b, c], c.id, a.id, 'right', () => 'row1');
  blocks = moveBlockBeside(blocks, b.id, c.id, 'left', () => 'unused');
  assert.deepEqual(layout(blocks), ['A | B | C']);
});

test('dropping a block between lines of a column joins that column; dragging it out ends the row', () => {
  const [a, b, c, d] = [line('A'), line('B'), line('C'), line('D')];
  let blocks = moveBlockBeside([a, b, c, d], b.id, a.id, 'right', () => 'row1');
  const beforeB = blocks.findIndex((x) => x.id === b.id);
  blocks = moveBlockBefore(blocks, c.id, beforeB);
  assert.deepEqual(layout(blocks), ['A | C+B', 'D']);
  blocks = moveBlockBefore(blocks, a.id, blocks.length);
  blocks = moveBlockBefore(blocks, c.id, blocks.length);
  assert.deepEqual(layout(blocks), ['B', 'D', 'A', 'C']);
  assert.equal(blocks.some((x) => x.row), false);
});

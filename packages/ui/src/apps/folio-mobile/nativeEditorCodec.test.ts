import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The phone's page editor is Swift, and its codec cannot run in this suite. What must not drift is
 * the boundary the summaries drawn in the text view depend on: a `database`, `page` or `pageIn`
 * block is read back from the page's own copy of itself rather than from the line that was drawn, so
 * a summary can only ever be a picture of the block, never a new version of it. These assertions read
 * the codec itself, so removing a kind from that set, moving the restore after the mark reading, or
 * joining a summary with a real newline — which would end the block's paragraph and hand the rest of
 * the summary a fresh id — fails here rather than on someone's page.
 */
const codec = readFileSync(join(__dirname, '..', '..', '..', '..', 'mobile', 'folio', 'ios', 'App', 'App', 'FolioNoteEditor.swift'), 'utf8');

const lockedLiteral = /\/\/\/ Kinds whose line is not typed text[\s\S]*?static let locked: Set<String> = \[([^\]]*)\]/.exec(codec)?.[1] ?? '';
const lockedKinds = [...lockedLiteral.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

describe('the native editor reads a drawn block back from the page, not from the text', () => {
  test('every kind this change draws under its title is a kind the codec restores verbatim', () => {
    for (const kind of ['database', 'page', 'pageIn']) expect(lockedKinds).toContain(kind);
  });

  test('a locked block is restored before its line is read for marks', () => {
    const restore = codec.search(/if locked\.contains\(kind\), let old, id == originalID/);
    const marks = codec.search(/block\["marks"\] = marks/);
    expect(restore).toBeGreaterThan(0);
    expect(marks).toBeGreaterThan(0);
    expect(restore).toBeLessThan(marks);
  });

  test('an embedded summary is joined with line separators, so the block keeps one paragraph', () => {
    // A newline ends a paragraph. The lines after it would be read as blocks of their own, without
    // the id that lets the codec recognise the block they belong to, and written back that way.
    expect(codec).toContain('lines.joined(separator: "\\u{2028}")');
    expect(codec).not.toContain('lines.joined(separator: "\\n")');
  });

  // Text typed into one of these lines is dropped on the next save, because the block comes back from
  // the page rather than from the line. Refusing the keystroke says so; silently taking it does not.
  test('a locked line refuses an edit that does not remove it', () => {
    expect(/if FolioCodec\.locked\.contains\(line\.kind\) \{\n\s+let clears = range\.location <= line\.range\.location && NSMaxRange\(range\) >= line\.range\.location \+ line\.range\.length\n\s+if !clears \{ return false \}/.test(codec)).toBe(true);
  });
});

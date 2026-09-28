import { displayColumns, embeddedView, viewRows } from './database';
import type { FolioBlock, FolioNote, FolioTable } from './schema';

/**
 * What the iPhone's native editor draws in place of a database or a page a block points at.
 *
 * The editor is a single text view holding one paragraph per block, so an embedded object is drawn
 * as its title followed by a few lines of read-only text — the same move the simple `table` block
 * already makes. None of this is stored: the summaries travel to the editor beside the page, and a
 * `database`, `page` or `pageIn` block is read back from the page's own copy of itself rather than
 * from what was drawn, so a summary can only ever be a picture of the block, never a new version of it.
 */

/** An embedded database: the rows it holds, in text, and how many of them are not on the page. */
export interface FolioDatabaseEmbed {
  kind: 'database';
  /** One line per row shown, already that row's title and values as text. */
  rows: string[];
  /** How many rows of the view the summary leaves out. */
  hidden: number;
}

/** A page link shows the page's own first line, so a page listing more than a column of titles. */
export interface FolioPageEmbed {
  kind: 'page';
  snippet: string;
}

export type FolioEmbedPreview = FolioDatabaseEmbed | FolioPageEmbed;

/** The summaries for one page's embeds, keyed by the asset their block points at, as the editor wants them. */
export type FolioEmbedPreviews = Record<string, FolioEmbedPreview>;

/** Rows and values per embedded database: enough to recognise the table, short enough to read in place. */
const shownRows = 4;
const shownValues = 2;
const snippetLimit = 140;

/** Blocks whose text names something else rather than being something to read. */
const referenceKinds: ReadonlySet<FolioBlock['kind']> = new Set(['database', 'table', 'page', 'pageIn', 'attachment', 'button', 'divider']);

/** One row as a line of text: its title, then the first values the view shows, in the view's order. */
function rowLine(row: FolioTable['rows'][number], titleColumn: FolioTable['columns'][number] | undefined, valueColumns: FolioTable['columns'][number][]): string {
  // A row nobody filled in has no entry for a column at all, so every value is read the same way:
  // what is there, or nothing.
  const title = (titleColumn ? row.values[titleColumn.id] ?? '' : '').trim();
  const values = valueColumns.map((column) => (row.values[column.id] ?? '').trim()).filter(Boolean);
  return [title, ...values.slice(0, shownValues)].filter(Boolean).join(' · ');
}

/**
 * The rows a page's embedded database shows in place, and how many of that view's rows the summary
 * leaves out. The rows come from the same view resolution and the same row selection the grid uses,
 * so the summary counts what opening the database would show rather than what it happens to hold.
 */
export function databaseEmbed(table: FolioTable, viewID: string | undefined): FolioDatabaseEmbed {
  const view = embeddedView(table, viewID);
  const titleColumn = table.columns.find((column) => column.kind === 'title') ?? table.columns[0];
  const valueColumns = displayColumns(table, view).filter((column) => column !== titleColumn);
  const rows: string[] = [];
  let hidden = 0;
  for (const row of viewRows(table, view)) {
    const line = rowLine(row, titleColumn, valueColumns);
    // A row with nothing in it would draw as a blank line, so it joins the rows the summary does not
    // show. The count stays the number of rows the view holds that the summary did not put on screen.
    if (rows.length < shownRows && line) rows.push(line);
    else hidden += 1;
  }
  return { kind: 'database', rows, hidden };
}

/** The first line of a page's own writing, for a page link to show more than a bare title. */
export function pageEmbed(note: FolioNote | undefined): FolioPageEmbed | undefined {
  const first = note?.blocks.find((block) => !referenceKinds.has(block.kind) && block.text.trim());
  const text = first?.text.replace(/\s+/g, ' ').trim() ?? '';
  if (!text) return undefined;
  return { kind: 'page', snippet: text.length > snippetLimit ? `${text.slice(0, snippetLimit - 1).trimEnd()}…` : text };
}

/**
 * Summaries for everything this page embeds, keyed by the asset its block points at. Only the blocks
 * of the open page are walked, so a large notebook costs one map lookup per link rather than a pass
 * over every note in it.
 */
export function embedPreviews(blocks: readonly FolioBlock[], notes: ReadonlyMap<string, FolioNote>): FolioEmbedPreviews {
  const entries: Array<[string, FolioEmbedPreview]> = [];
  const named = new Set<string>();
  for (const block of blocks) {
    const asset = block.asset;
    if (!asset || named.has(asset)) continue;
    if (block.kind === 'database') {
      const target = notes.get(asset);
      if (!target?.table) continue;
      named.add(asset);
      entries.push([asset, databaseEmbed(target.table, block.text || undefined)]);
    } else if (block.kind === 'page' || block.kind === 'pageIn') {
      const embed = pageEmbed(notes.get(asset));
      if (!embed) continue;
      named.add(asset);
      entries.push([asset, embed]);
    }
  }
  return Object.fromEntries(entries);
}

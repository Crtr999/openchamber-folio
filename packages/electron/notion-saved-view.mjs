import { z } from 'zod';

const viewSchema = z.object({
  dataSourceUrl: z.string(), name: z.string(), type: z.enum(['table', 'board', 'list', 'gallery', 'calendar', 'timeline']),
  displayProperties: z.array(z.string()),
}).passthrough();
const pageSchema = z.strictObject({
  results: z.array(z.record(z.string(), z.json())), has_more: z.boolean(),
  next_cursor: z.string().min(1).max(200).nullable().optional(),
  truncated: z.boolean().optional(), notices: z.array(z.json()).optional(),
});
const unwrapped = (url) => url.replace(/^\{\{/, '').replace(/\}\}$/, '');
const incomplete = () => new Error('Notion returned an incomplete saved view. Refresh or check the view permissions in Notion before making changes.');
const setup = () => new Error('This database needs an unfiltered saved view with all task or habit properties visible. Add a dedicated integration view in the existing Notion database, then refresh. Do not recreate the database.');

function restrictsRows(value) {
  if (Array.isArray(value)) return value.some(restrictsRows);
  const object = z.record(z.string(), z.json()).safeParse(value);
  if (!object.success) return false;
  return Object.entries(object.data).some(([key, child]) => {
    if (/filter|hiddenGroups|hiddenSubgroups|rowLimit/i.test(key)) {
      if (child !== null && child !== false && !(Array.isArray(child) && child.length === 0)) return true;
    }
    return restrictsRows(child);
  });
}

function views(text) {
  return [...text.matchAll(/<view url="(?:\{\{)?(view:\/\/[0-9a-f-]+)(?:\}\})?">\s*([\s\S]*?)\s*<\/view>/gi)]
    .map((match) => {
      let state;
      try { state = JSON.parse(match[2]); } catch { throw setup(); }
      return { url: match[1], state: viewSchema.safeParse(state) };
    });
}

// Source and view metadata are fetched again on every read, including every
// membership check. A filtered view cannot authorize absence or a new habit day.
export async function readSavedViewRows({ tool, source, text, properties }) {
  const candidates = views(text).filter(({ state }) => state.success && unwrapped(state.data.dataSourceUrl) === source.url
    && !restrictsRows(state.data) && properties.every((name) => state.data.displayProperties.includes(name)));
  if (!candidates.length) throw setup();
  const selected = candidates[0];
  const fetched = z.object({ text: z.string(), truncated: z.boolean().optional() }).parse(await tool('fetch', { id: selected.url }));
  if (fetched.truncated || fetched.text.includes('<unknown')) throw incomplete();
  const current = views(fetched.text).find((view) => view.url === selected.url);
  if (!current?.state.success || unwrapped(current.state.data.dataSourceUrl) !== source.url
    || restrictsRows(current.state.data) || !properties.every((name) => current.state.data.displayProperties.includes(name))) throw setup();
  const rows = [];
  const cursors = new Set();
  const pages = new Set();
  let cursor;
  do {
    const data = { mode: 'view', view_url: selected.url, page_size: 100 };
    if (cursor) data.start_cursor = cursor;
    const parsed = pageSchema.safeParse(await tool('query-data-sources', { data }));
    if (!parsed.success || parsed.data.truncated || parsed.data.notices?.length) throw incomplete();
    const response = parsed.data;
    for (const row of response.results) {
      const url = z.string().safeParse(row.url);
      if (!url.success || pages.has(url.data)) throw incomplete();
      pages.add(url.data); rows.push(row);
    }
    if (!response.has_more) {
      if (response.next_cursor) throw incomplete();
      return rows;
    }
    if (!response.next_cursor || cursors.has(response.next_cursor) || cursors.size >= 1000) throw incomplete();
    cursor = response.next_cursor; cursors.add(cursor);
  } while (cursor);
  throw incomplete();
}

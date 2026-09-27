import { randomUUID } from 'node:crypto';
import { markdownToNote, noteToMarkdown } from '../ui/src/lib/folio/local-engine.ts';

/**
 * The `folio` agent tool: an OpenCode session reads and edits the user's notebook through the
 * running engine, the same writer the notebook UI uses. It never opens the library file, so the
 * app never has to close, and each write is checked against the page's latest revision.
 *
 * Pages marked "exclude from AI" can be listed by title but never read or changed.
 */
export function createFolioAgent({ engine, onChanged = () => {} }) {
  const state = async () => {
    const response = await engine.request({ command: 'state' });
    if (!response.ok || !response.state) throw new Error(response.error || 'Folio could not read the notebook.');
    return response.state;
  };
  const live = (notes) => notes.filter((note) => !note.trashed && !note.isChat);
  const summary = (note) => ({ id: note.id, title: note.title || 'Untitled', ...(note.parentID ? { parent: note.parentID } : {}), ...(note.table ? { database: true } : {}), ...(note.excludedFromAI ? { excludedFromAI: true } : {}) });

  /** A page by id, exact title, or a title that only one page contains. */
  const resolve = (notes, reference, label = 'page') => {
    const wanted = typeof reference === 'string' ? reference.trim().replace(/^@/, '') : '';
    if (!wanted) throw usage(`${label} is required: a page id from a result, or the page title.`);
    const pages = live(notes);
    const byID = pages.find((note) => note.id.toLowerCase() === wanted.toLowerCase());
    if (byID) return byID;
    const lower = wanted.toLowerCase();
    const exact = pages.filter((note) => (note.title || 'Untitled').trim().toLowerCase() === lower);
    if (exact.length === 1) return exact[0];
    const partial = exact.length ? exact : pages.filter((note) => (note.title || '').toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0];
    if (!partial.length) throw usage(`No page matches "${wanted}". Use folio.search or folio.list to find it.`);
    throw usage(`Several pages match "${wanted}"; pass one of these ids: ${partial.slice(0, 8).map((note) => `${note.id} (${note.title || 'Untitled'})`).join(', ')}`);
  };
  const readable = (note) => {
    if (note.excludedFromAI) throw usage(`"${note.title || 'Untitled'}" is excluded from AI by the user.`);
    return note;
  };

  /** Saves a changed page against the revision it was read at; one retry on top of a newer revision. */
  const save = async (noteID, change) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = readable(resolve((await state()).notes, noteID));
      const next = change(current);
      const response = await engine.request({ command: 'save', note: next, expectedModified: current.modified });
      if (response.ok) { onChanged([noteID]); return response.state?.notes.find((note) => note.id === noteID) ?? next; }
      if (attempt === 1 || !/changed in another view/i.test(response.error ?? '')) throw new Error(response.error || 'Folio could not save the page.');
    }
    throw new Error('Folio could not save the page.');
  };

  const blocksFrom = (markdown) => {
    const text = typeof markdown === 'string' ? markdown : '';
    if (!text.trim()) throw usage('markdown is required.');
    // A leading "# " line is a heading here, not a page title.
    return markdownToNote(`# \n${text}`, '', Date.now()).blocks.filter((block, index, all) => all.length === 1 || block.text || block.kind !== 'text');
  };
  const blockIndex = (note, blockID, label) => {
    const index = note.blocks.findIndex((block) => block.id.toLowerCase() === String(blockID ?? '').toLowerCase());
    if (index < 0) throw usage(`${label} was not found in "${note.title || 'Untitled'}". Read the page again for current block ids.`);
    return index;
  };
  const table = (note) => {
    if (!note.table) throw usage(`"${note.title || 'Untitled'}" is not a database.`);
    return note.table;
  };
  /** Cell values keyed by column id, from names or ids given by the model. */
  const cells = (grid, values) => {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw usage('values is required: column name to text.');
    const out = {};
    for (const [key, value] of Object.entries(values)) {
      const column = grid.columns.find((c) => c.id === key || c.name.trim().toLowerCase() === key.trim().toLowerCase());
      if (!column) throw usage(`No column "${key}". Columns: ${grid.columns.map((c) => c.name).join(', ')}`);
      out[column.id] = value === null || value === undefined ? '' : String(value);
    }
    return out;
  };
  const rowIndex = (grid, rowID) => {
    const index = grid.rows.findIndex((row) => row.id === rowID);
    if (index < 0) throw usage(`Row ${rowID ?? ''} was not found. Read the database again for current row ids.`);
    return index;
  };

  const actions = {
    'folio.list': async ({ parent }) => {
      const notes = (await state()).notes;
      const parentID = parent ? resolve(notes, parent, 'parent').id : undefined;
      const pages = live(notes).filter((note) => (parentID ? note.parentID === parentID : true));
      return { pages: pages.slice(0, 300).map(summary), total: pages.length };
    },
    'folio.search': async ({ query }) => {
      const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
      if (!q) throw usage('query is required.');
      const pages = live((await state()).notes);
      const hits = [];
      for (const note of pages) {
        const inTitle = (note.title || '').toLowerCase().includes(q);
        const block = note.excludedFromAI ? undefined : note.blocks.find((b) => b.text.toLowerCase().includes(q));
        const row = note.excludedFromAI || !note.table ? undefined : note.table.rows.find((r) => Object.values(r.values).some((v) => v.toLowerCase().includes(q)));
        if (!inTitle && !block && !row) continue;
        const line = block ? block.text.slice(0, 200) : row ? Object.values(row.values).join(' · ').slice(0, 200) : undefined;
        hits.push({ ...summary(note), ...(line ? { match: line } : {}) });
        if (hits.length >= 25) break;
      }
      return { results: hits };
    },
    'folio.read': async ({ page }) => {
      const note = readable(resolve((await state()).notes, page));
      return {
        ...summary(note),
        markdown: noteToMarkdown(note),
        blocks: note.blocks.map((block) => ({ id: block.id, kind: block.kind, text: block.text.slice(0, 500), ...(block.kind === 'task' ? { checked: block.checked } : {}), ...(block.kind === 'page' && block.asset ? { page: block.asset } : {}) })),
        ...(note.table ? { columns: note.table.columns.map((c) => ({ name: c.name, kind: c.kind, ...(c.options.length ? { options: c.options } : {}) })), rows: note.table.rows.map((row) => ({ id: row.id, ...Object.fromEntries(note.table.columns.map((c) => [c.name, row.values[c.id] ?? ''])) })) } : {}),
      };
    },
    'folio.create': async ({ title, markdown, parent }) => {
      const name = typeof title === 'string' ? title.trim() : '';
      if (!name) throw usage('title is required.');
      const before = await state();
      const parentID = parent ? readable(resolve(before.notes, parent, 'parent')).id : undefined;
      const created = await engine.request({ command: 'create', text: name, ...(parentID ? { parentID } : {}) });
      const createdID = created.state?.selectedID;
      if (!created.ok || !createdID || createdID === before.selectedID) throw new Error(created.error || 'Folio could not create the page.');
      // Creating opens the new page; put the user back on the page they had open.
      if (before.selectedID) await engine.request({ command: 'select', noteID: before.selectedID }).catch(() => undefined);
      if (typeof markdown === 'string' && markdown.trim()) await save(createdID, (note) => ({ ...note, blocks: blocksFrom(markdown) }));
      else onChanged([createdID]);
      return { id: createdID, title: name };
    },
    'folio.append': async ({ page, markdown }) => {
      const blocks = blocksFrom(markdown);
      const note = await save(resolve((await state()).notes, page).id, (current) => {
        // A page that is only one empty line gets the content instead of keeping the blank line.
        const empty = current.blocks.length === 1 && !current.blocks[0].text && current.blocks[0].kind === 'text';
        return { ...current, blocks: empty ? blocks : [...current.blocks, ...blocks] };
      });
      return { id: note.id, added: blocks.map((block) => block.id) };
    },
    'folio.insert': async ({ page, markdown, afterBlockId }) => {
      const blocks = blocksFrom(markdown);
      const note = await save(resolve((await state()).notes, page).id, (current) => {
        const at = afterBlockId ? blockIndex(current, afterBlockId, 'afterBlockId') + 1 : 0;
        return { ...current, blocks: [...current.blocks.slice(0, at), ...blocks, ...current.blocks.slice(at)] };
      });
      return { id: note.id, added: blocks.map((block) => block.id) };
    },
    'folio.update_block': async ({ page, blockId, markdown }) => {
      const blocks = blocksFrom(markdown);
      await save(resolve((await state()).notes, page).id, (current) => {
        const at = blockIndex(current, blockId, 'blockId');
        const [first, ...rest] = blocks;
        // The edited line keeps its id (and indent), so links and later edits still find it.
        const replaced = { ...first, id: current.blocks[at].id, ...(current.blocks[at].indent ? { indent: current.blocks[at].indent } : {}) };
        return { ...current, blocks: [...current.blocks.slice(0, at), replaced, ...rest, ...current.blocks.slice(at + 1)] };
      });
      return { updated: blockId };
    },
    'folio.delete_block': async ({ page, blockId }) => {
      await save(resolve((await state()).notes, page).id, (current) => {
        const at = blockIndex(current, blockId, 'blockId');
        const blocks = current.blocks.filter((_, index) => index !== at);
        return { ...current, blocks: blocks.length ? blocks : [{ ...current.blocks[at], id: randomUUID().toUpperCase(), kind: 'text', text: '', marks: [], checked: false }] };
      });
      return { deleted: blockId };
    },
    'folio.rename': async ({ page, title }) => {
      const name = typeof title === 'string' ? title.trim() : '';
      if (!name) throw usage('title is required.');
      await save(resolve((await state()).notes, page).id, (current) => ({ ...current, title: name }));
      return { title: name };
    },
    'folio.add_row': async ({ page, values }) => {
      const id = randomUUID().toUpperCase();
      await save(resolve((await state()).notes, page).id, (current) => {
        const grid = table(current);
        return { ...current, table: { ...grid, rows: [...grid.rows, { id, values: cells(grid, values) }] } };
      });
      return { rowId: id };
    },
    'folio.update_row': async ({ page, rowId, values }) => {
      await save(resolve((await state()).notes, page).id, (current) => {
        const grid = table(current);
        const at = rowIndex(grid, rowId);
        const rows = grid.rows.map((row, index) => (index === at ? { ...row, values: { ...row.values, ...cells(grid, values) } } : row));
        return { ...current, table: { ...grid, rows } };
      });
      return { rowId };
    },
    'folio.delete_row': async ({ page, rowId }) => {
      await save(resolve((await state()).notes, page).id, (current) => {
        const grid = table(current);
        const at = rowIndex(grid, rowId);
        return { ...current, table: { ...grid, rows: grid.rows.filter((_, index) => index !== at) } };
      });
      return { deleted: rowId };
    },
  };

  const execute = async (action, parameters = {}) => {
    const run = actions[action];
    if (!run) throw usage(`Unsupported Folio action ${action}. Use one of: ${Object.keys(actions).join(', ')}`);
    return run(parameters && typeof parameters === 'object' ? parameters : {});
  };
  return { execute };
}

/** Errors the model can fix by changing its call (reported to it as usage errors). */
function usage(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

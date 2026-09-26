import { z } from 'zod';
import type { LocalEngine } from '@/lib/folio/local-engine';
import { markdownToNote, noteToMarkdown } from '@/lib/folio/local-engine';
import type { AgentTool } from '@/lib/folio/mobile-chat';
import type { FolioNote } from '@/lib/folio/schema';
import { folioNoteLinkPrefix } from '@/components/folio/FolioRichBlock';

/**
 * Tools the phone assistant can call. They work on the notebook stored on this iPhone (which sync
 * keeps in step with the Mac), so they keep working with the Mac off. Pages excluded from AI stay
 * invisible to every tool.
 */

const parse = <T,>(schema: z.ZodType<T>, args: string): T => {
  try { return schema.parse(JSON.parse(args || '{}')); } catch { throw new Error('The tool arguments were not valid.'); }
};

const titleOf = (note: FolioNote) => note.title || 'Untitled';
const link = (note: FolioNote) => `[${titleOf(note).replace(/[[\]]/g, '')}](${folioNoteLinkPrefix}${note.id})`;
const textFile = /\.(txt|md|markdown|csv|json|html?|xml|ya?ml|log|tsv|swift|ts|js|py)$/i;

/** Simple ranking: every query word counts, title hits count more. Good enough for a personal notebook. */
export function rankNotes(notes: readonly FolioNote[], query: string, limit: number): FolioNote[] {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
  if (!words.length) return [];
  const scored = notes.map((note) => {
    const title = titleOf(note).toLowerCase();
    const body = note.blocks.map((b) => b.text).join('\n').toLowerCase();
    let score = 0;
    for (const word of words) {
      if (title.includes(word)) score += 5;
      let at = body.indexOf(word);
      for (let hits = 0; at >= 0 && hits < 10; hits += 1) { score += 1; at = body.indexOf(word, at + word.length); }
    }
    return { note, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || b.note.modified - a.note.modified).slice(0, limit).map((s) => s.note);
}

function snippet(note: FolioNote, query: string): string {
  const text = note.blocks.map((b) => b.text).filter(Boolean).join(' ');
  const word = query.toLowerCase().split(/\W+/).find((w) => w.length > 1 && text.toLowerCase().includes(w));
  const at = word ? Math.max(0, text.toLowerCase().indexOf(word) - 60) : 0;
  return text.slice(at, at + 200).replace(/\s+/g, ' ');
}

const queryArgs = z.object({ query: z.string().min(1).max(500) });
const idArgs = z.object({ id: z.string().min(1) });
const createArgs = z.object({ title: z.string().min(1).max(300), markdown: z.string().max(200_000), parentID: z.string().optional() });
const appendArgs = z.object({ id: z.string().min(1), markdown: z.string().min(1).max(200_000) });
const attachmentArgs = z.object({ id: z.string().min(1), name: z.string().min(1) });

const labelFrom = <T,>(schema: z.ZodType<T>, args: string, make: (value: T) => string, fallback: string) => {
  try { return make(schema.parse(JSON.parse(args || '{}'))); } catch { return fallback; }
};

export function createAgentTools({ engine, notes, events, onWrite }: {
  engine: LocalEngine;
  /** Current pages (read fresh on every call, so a page written a moment ago is found). */
  notes: () => readonly FolioNote[];
  events: () => readonly { title: string; start: number; end: number; calendar: string; joinURL?: string }[];
  onWrite: () => void;
}): AgentTool[] {
  const visible = () => notes().filter((n) => !n.trashed && !n.excludedFromAI && !n.isChat);
  const byID = (id: string) => {
    const note = visible().find((n) => n.id.toUpperCase() === id.replace(folioNoteLinkPrefix, '').toUpperCase());
    if (!note) throw new Error('That page was not found (it may be excluded from AI).');
    return note;
  };
  const titleFor = (id: string) => { try { return titleOf(byID(id)); } catch { return 'a page'; } };
  return [
    {
      name: 'search_notes',
      description: 'Search the user\'s Folio notebook. Returns matching pages with their IDs and a snippet. Use before answering questions about the user\'s notes.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Words to look for' } }, required: ['query'] },
      label: (args) => labelFrom(queryArgs, args, (a) => `Searched notes for “${a.query}”`, 'Searched notes'),
      run: async (args) => {
        const { query } = parse(queryArgs, args);
        const hits = rankNotes(visible(), query, 10);
        return hits.length ? hits.map((n) => `- ${link(n)} (id ${n.id}): ${snippet(n, query)}`).join('\n') : 'No pages matched.';
      },
    },
    {
      name: 'list_notes',
      description: 'List every page title in the notebook with IDs and parent pages, newest first.',
      parameters: { type: 'object', properties: {}, required: [] },
      label: () => 'Looked through the notebook',
      run: async () => visible().sort((a, b) => b.modified - a.modified).slice(0, 400)
        .map((n) => `- ${titleOf(n)} (id ${n.id}${n.parentID ? `, inside ${n.parentID}` : ''}, edited ${new Date(n.modified).toLocaleDateString()})`).join('\n') || 'The notebook is empty.',
    },
    {
      name: 'read_note',
      description: 'Read a whole page as Markdown, including the names of its attached files.',
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'Page ID' } }, required: ['id'] },
      label: (args) => labelFrom(idArgs, args, (a) => `Read “${titleFor(a.id)}”`, 'Read a page'),
      run: async (args) => {
        const note = byID(parse(idArgs, args).id);
        const files = note.blocks.filter((b) => b.kind === 'attachment').map((b) => b.text);
        return `Page ${link(note)}\n\n${noteToMarkdown(note).slice(0, 30_000)}${files.length ? `\n\nAttached files: ${files.join(', ')}` : ''}`;
      },
    },
    {
      name: 'read_attachment',
      description: 'Read a text file attached to a page (txt, md, csv, json and similar). Other file types cannot be read.',
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'Page ID' }, name: { type: 'string', description: 'File name as listed by read_note' } }, required: ['id', 'name'] },
      label: (args) => labelFrom(attachmentArgs, args, (a) => `Opened ${a.name}`, 'Opened a file'),
      run: async (args) => {
        const { id, name } = parse(attachmentArgs, args);
        const note = byID(id);
        if (!textFile.test(name)) return 'Only text files can be read here.';
        const file = await engine.attachment(note.id, name);
        if (!file) return 'That file is not on this iPhone and the Mac could not be reached.';
        return (await file.text()).slice(0, 40_000);
      },
    },
    {
      name: 'create_note',
      description: 'Create a new page from Markdown. Use only when the user asks you to write, save or draft something as a note.',
      parameters: { type: 'object', properties: { title: { type: 'string', description: 'Page title' }, markdown: { type: 'string', description: 'Page body in Markdown' }, parentID: { type: 'string', description: 'Optional parent page ID' } }, required: ['title', 'markdown'] },
      label: (args) => labelFrom(createArgs, args, (a) => `Created “${a.title}”`, 'Created a page'),
      run: async (args) => {
        const { title, markdown, parentID } = parse(createArgs, args);
        const note = { ...markdownToNote(markdown, title, Date.now()), title, icon: '', parentID: parentID ? byID(parentID).id : undefined };
        await engine.addNote(note);
        onWrite();
        return `Created ${link(note)} (id ${note.id}).`;
      },
    },
    {
      name: 'append_to_note',
      description: 'Add Markdown to the end of an existing page. Use only when the user asks you to add to a note.',
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'Page ID' }, markdown: { type: 'string', description: 'Text to add' } }, required: ['id', 'markdown'] },
      label: (args) => labelFrom(appendArgs, args, (a) => `Added to “${titleFor(a.id)}”`, 'Added to a page'),
      run: async (args) => {
        const { id, markdown } = parse(appendArgs, args);
        const note = byID(id);
        const reply = await engine.request({ command: 'append', noteID: note.id, text: markdown });
        if (!reply.ok) throw new Error(reply.error ?? 'Could not add to that page.');
        onWrite();
        return `Added to ${link(note)}.`;
      },
    },
    {
      name: 'upcoming_events',
      description: 'The user\'s calendar events for the next seven days (only if they connected their calendar in Folio).',
      parameters: { type: 'object', properties: {}, required: [] },
      label: () => 'Checked the calendar',
      run: async () => events().map((e) => `- ${e.title}: ${new Date(e.start).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} – ${new Date(e.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} (${e.calendar})${e.joinURL ? ' · video call' : ''}`).join('\n') || 'No upcoming events, or the calendar is not connected in Folio.',
    },
  ];
}

export interface LibraryContext { text: string; ids: string[] }

/** Context for "whole library": the page catalogue plus the pages that best match the question. */
export function libraryContext(notes: readonly FolioNote[], question: string): LibraryContext {
  const visible = notes.filter((n) => !n.trashed && !n.excludedFromAI && !n.isChat);
  const hits = rankNotes(visible, question, 6);
  const catalogue = visible.sort((a, b) => b.modified - a.modified).slice(0, 250).map((n) => `- ${titleOf(n)} (id ${n.id})`).join('\n');
  const excerpts = hits.map((n) => `Page ${link(n)} (id ${n.id})\n${noteToMarkdown(n).slice(0, 6000)}`).join('\n\n---\n\n');
  return { text: `ALL PAGES:\n${catalogue}\n\nMOST RELEVANT PAGES:\n${excerpts || 'None matched this question.'}`, ids: hits.map((n) => n.id) };
}

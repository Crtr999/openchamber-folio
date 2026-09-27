import type { FolioAPI, FolioNote, FolioRequest, FolioResponse } from './schema';

/**
 * Keeps the Mac notebook's pages in the renderer and asks the engine only for pages that changed.
 * The engine answers a request carrying `since` with the changed pages plus every page id, so a save
 * no longer re-sends (and re-validates) a notebook that holds large imported databases.
 * Callers still see a full state: pages missing from the reply come from the last one.
 */
export function withNoteDeltas(send: (input: FolioRequest) => Promise<FolioResponse>): FolioAPI {
  let pages = new Map<string, FolioNote>();
  let version: string | undefined;
  const request = async (input: FolioRequest, delta: boolean): Promise<FolioResponse> => {
    const response = await send(delta && version ? { ...input, since: version } : input);
    const state = response.state;
    if (!state) return response;
    const { noteIDs, version: next, ...rest } = response;
    if (!noteIDs) {
      pages = new Map(state.notes.map((note) => [note.id, note]));
      version = next;
      return rest;
    }
    const changed = new Map(state.notes.map((note) => [note.id, note]));
    const notes: FolioNote[] = [];
    for (const id of noteIDs) {
      const note = changed.get(id) ?? pages.get(id);
      // A page this renderer never received: the command already ran, so fetch the whole notebook once.
      if (!note) { version = undefined; return request({ command: 'state' }, false).then((full) => ({ ...rest, state: full.state ? { ...state, notes: full.state.notes } : state })); }
      notes.push(note);
    }
    pages = new Map(notes.map((note) => [note.id, note]));
    version = next;
    return { ...rest, state: { ...state, notes } };
  };
  return { request: (input) => request(input, true) };
}

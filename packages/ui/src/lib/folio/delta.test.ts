import { describe, expect, test } from 'bun:test';
import { withNoteDeltas } from './delta';
import type { FolioNote, FolioRequest, FolioResponse, FolioStatus } from './schema';

const page = (id: string, title: string): FolioNote => ({ id, title, icon: '', blocks: [], tags: [], favorite: false, excludedFromAI: false, isMeeting: false, trashed: false, created: 1, modified: 1 });
const status = (notes: FolioNote[]): FolioStatus => ({ notes, status: '', importing: false, importProgress: '', listening: false, dictation: '', speaking: false, paused: false, voiceID: '', rate: 0.5, voices: [], recording: false, recordingStarting: false, transcribing: false, recordingProgress: '', microphoneLevel: 0, systemLevel: 0, calendarConnected: false, events: [], reminders: false, fontSize: 16, highlightStrength: 1, aiBusy: false, messages: [] });
const A = '00000000-0000-4000-8000-00000000000A', B = '00000000-0000-4000-8000-00000000000B', C = '00000000-0000-4000-8000-00000000000C';

describe('withNoteDeltas', () => {
  test('fills unchanged pages from the last reply and sends since', async () => {
    const sent: FolioRequest[] = [];
    const replies: FolioResponse[] = [
      { id: '1', ok: true, state: status([page(A, 'a'), page(B, 'b')]), version: 'e:1' },
      { id: '2', ok: true, state: status([page(B, 'b2')]), noteIDs: [B, A], version: 'e:2' },
    ];
    const api = withNoteDeltas(async (input) => { sent.push(input); return replies.shift()!; });
    await api.request({ command: 'state' });
    const second = await api.request({ command: 'state' });
    expect(sent[1].since).toBe('e:1');
    expect(second.state?.notes.map((n) => n.title)).toEqual(['b2', 'a']);
    expect(second.noteIDs).toBeUndefined();
  });
  test('refetches everything when a page is unknown', async () => {
    const replies: FolioResponse[] = [
      { id: '1', ok: true, state: status([page(A, 'a')]), version: 'e:1' },
      { id: '2', ok: true, state: status([]), noteIDs: [A, C], version: 'e:2' },
      { id: '3', ok: true, state: status([page(A, 'a'), page(C, 'c')]), version: 'e:2' },
    ];
    const api = withNoteDeltas(async () => replies.shift()!);
    await api.request({ command: 'state' });
    const next = await api.request({ command: 'state' });
    expect(next.state?.notes.map((n) => n.title)).toEqual(['a', 'c']);
  });
});

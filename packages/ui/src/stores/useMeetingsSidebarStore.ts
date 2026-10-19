import { create } from 'zustand';
import { listMeetings, meetingsSupported, type Meeting } from '@/lib/meetings/contract';
import type { Session } from '@/lib/opencode/model';
import { normalizePath } from '@/lib/pathNormalization';

export const MEETING_SESSION_PREFIX = 'meeting:';
const MEETING_DIRECTORIES_STORAGE_KEY = 'open-carter:meeting-directories.v1';

export const isMeetingSessionId = (id: string | null | undefined): boolean =>
  typeof id === 'string' && id.startsWith(MEETING_SESSION_PREFIX);

export const meetingIdFromSessionId = (id: string | null | undefined): string | null =>
  isMeetingSessionId(id) ? String(id).slice(MEETING_SESSION_PREFIX.length) : null;

export const isSidebarVisibleMeeting = (meeting: Meeting): boolean =>
  meeting.status !== 'draft' || meeting.segments.length > 0 || meeting.notes.trim().length > 0;

const readStoredDirectories = (): Record<string, string> => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return {};
    const raw = window.localStorage.getItem(MEETING_DIRECTORIES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [id, dir] of Object.entries(parsed)) {
      if (typeof id === 'string' && typeof dir === 'string' && dir.trim()) {
        const normalized = normalizePath(dir.trim());
        if (normalized) out[id] = normalized;
      }
    }
    return out;
  } catch {
    return {};
  }
};

const writeStoredDirectories = (map: Record<string, string>): void => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(MEETING_DIRECTORIES_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore storage errors
  }
};

export const toMeetingSession = (meeting: Meeting, directory: string): Session => {
  const created = Date.parse(meeting.createdAt);
  const updated = Date.parse(meeting.updatedAt);
  const createdMs = Number.isFinite(created) ? created : Date.now();
  const updatedMs = Number.isFinite(updated) ? updated : createdMs;
  return {
    id: `${MEETING_SESSION_PREFIX}${meeting.id}`,
    title: meeting.title,
    directory,
    time: {
      created: createdMs,
      updated: updatedMs,
    },
  } as Session;
};

type MeetingsSidebarState = {
  meetings: Meeting[];
  directoriesById: Record<string, string>;
  loaded: boolean;
  setMeetings: (meetings: Meeting[]) => void;
  upsertMeeting: (meeting: Meeting, directory?: string | null) => void;
  setMeetingDirectory: (meetingId: string, directory: string | null | undefined) => void;
  refreshMeetings: () => Promise<void>;
};

export const useMeetingsSidebarStore = create<MeetingsSidebarState>((set, get) => ({
  meetings: [],
  directoriesById: readStoredDirectories(),
  loaded: false,
  setMeetings: (meetings) => set({ meetings, loaded: true }),
  upsertMeeting: (meeting, directory) => {
    const current = get();
    const exists = current.meetings.some((item) => item.id === meeting.id);
    const nextMeetings = exists
      ? current.meetings.map((item) => (item.id === meeting.id ? meeting : item))
      : [meeting, ...current.meetings];
    if (directory !== undefined) {
      const normalized = normalizePath(directory ?? null);
      const nextDirs = { ...current.directoriesById };
      if (normalized) nextDirs[meeting.id] = normalized;
      else delete nextDirs[meeting.id];
      writeStoredDirectories(nextDirs);
      set({ meetings: nextMeetings, directoriesById: nextDirs, loaded: true });
      return;
    }
    set({ meetings: nextMeetings, loaded: true });
  },
  setMeetingDirectory: (meetingId, directory) => {
    const current = get();
    const normalized = normalizePath(directory ?? null);
    const nextDirs = { ...current.directoriesById };
    if (normalized) nextDirs[meetingId] = normalized;
    else delete nextDirs[meetingId];
    writeStoredDirectories(nextDirs);
    set({ directoriesById: nextDirs });
  },
  refreshMeetings: async () => {
    if (!meetingsSupported()) return;
    try {
      const result = await listMeetings();
      set({ meetings: result.meetings, loaded: true });
    } catch {
      // ignore background list errors
    }
  },
}));

import { z } from 'zod';
import { invokeDesktop, isElectronShell, isDesktopLocalOriginActive } from '@/lib/desktop';
import { opencodeClient } from '@/lib/opencode/client';
import type { Session } from '@/lib/opencode/model';

export const personalHomeSupported = () => isElectronShell() && isDesktopLocalOriginActive();
const statusSchema = z.object({ connected: z.boolean(), signingIn: z.boolean(), board: z.string(), habits: z.string(), destination: z.string() });
const boardSchema = z.object({ name: z.string(), columns: z.array(z.string()), rows: z.array(z.object({ url: z.string(), title: z.string().nullable(), status: z.string().nullable(), due: z.object({ start: z.string(), end: z.string().nullable(), isDatetime: z.boolean() }).nullable().default(null) })), limited: z.boolean() });
const calendarSchema = z.object({ access: z.enum(['connected', 'not-connected', 'unsupported']), error: z.string().optional(), calendars: z.array(z.object({ id: z.string(), title: z.string(), writable: z.boolean() })).default([]), events: z.array(z.object({ id: z.string(), title: z.string(), start: z.string(), end: z.string(), allDay: z.boolean(), calendarId: z.string(), calendarTitle: z.string(), writable: z.boolean() })).default([]) });
export type HomeNotionStatus = z.infer<typeof statusSchema>;
export type HomeNotionBoard = z.infer<typeof boardSchema>;
export type HomeCalendar = z.infer<typeof calendarSchema>;
export type HomeCalendarEvent = HomeCalendar['events'][number];
const invoke = (args: Parameters<typeof invokeDesktop>[1]) => {
    if (!personalHomeSupported()) throw new Error('Personal connections require the desktop app.');
    return invokeDesktop('desktop_personal_home', args);
};
export const readHomeNotionStatus = async () => statusSchema.parse(await invoke({ action: 'status' }));
export const readHomeBoard = async () => boardSchema.parse(await invoke({ action: 'board' }));
export const connectHomeNotion = () => invoke({ action: 'connect' });
export const configureHomeNotion = (board: string, habits: string, destination: string) => invoke({ action: 'configure', board, habits, destination });
export const moveHomeTask = (page: string, status: string) => invoke({ action: 'move', page, status });
export const createHomeTask = (title: string, status?: string) => invoke({ action: 'create-task', title, status });
export const renameHomeTask = (page: string, title: string) => invoke({ action: 'rename-task', page, title });
export const deleteHomeTask = (page: string) => invoke({ action: 'delete-task', page });
export const readHomeCalendar = async (connect = false) => calendarSchema.parse(await invoke({ action: 'calendar', op: connect ? 'connect' : 'read' }));
const savedEventSchema = z.object({ access: z.enum(['connected', 'not-connected', 'unsupported']), savedId: z.string().optional(), error: z.string().optional() });
export const saveHomeEvent = async (event: { id?: string; title: string; start: string; end: string; calendarId: string }) => {
    const result = savedEventSchema.parse(await invoke({ action: 'calendar', op: 'save', ...event }));
    if (result.error) throw new Error(result.error);
    if (result.access !== 'connected' || !result.savedId) throw new Error('Connect Calendar before saving an event.');
    return result;
};

export async function exportHomeChat(session: Session, roles: { user: string; assistant: string }) {
    const records = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
        const page = await opencodeClient.getSessionMessages(session.id, { limit: 100, cursor, order: 'asc' }, session.directory);
        records.push(...page.items);
        cursor = page.cursor.next;
        if (cursor && seen.has(cursor)) throw new Error('The chat could not be loaded completely. Try again.');
        if (cursor) seen.add(cursor);
    } while (cursor);
    const content = records.sort((a, b) => a.info.time.created - b.info.time.created).flatMap(({ info, parts }) => {
        const text = parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n\n');
        return text.trim() ? [`## ${info.role === 'user' ? roles.user : roles.assistant}\n\n${text}`] : [];
    }).join('\n\n---\n\n');
    return invoke({ action: 'export', title: session.title, content });
}

/** Save a meeting (summary, notes, transcript) as a page under the saved-chats Notion page. */
export const exportMeetingToNotion = (title: string, content: string) => invoke({ action: 'export', title, content });

const habitsSchema = z.object({ day: z.string(), page: z.string().nullable(), items: z.array(z.object({ name: z.string(), checked: z.boolean() })) });
export type HomeHabits = z.infer<typeof habitsSchema>;
export const readHomeHabits = async (day: string) => habitsSchema.parse(await invoke({ action: 'habits', day }));
export const startHomeDay = async (day: string) => habitsSchema.parse(await invoke({ action: 'start-day', day }));
export const toggleHomeHabit = (page: string, name: string, checked: boolean) => invoke({ action: 'habit', page, name, checked });
export const disconnectHomeNotion = () => invoke({ action: 'disconnect' });

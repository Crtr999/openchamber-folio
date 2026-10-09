import { z } from 'zod';
import { hasDesktopInvoke, invokeDesktop, isElectronShell, isDesktopLocalOriginActive } from '@/lib/desktop';

export const meetingSchema = z.object({
    version: z.literal(1), id: z.string().uuid(), title: z.string(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
    status: z.enum(['draft', 'recording', 'paused', 'stopped', 'interrupted']), interruptionReason: z.string().nullable(), notes: z.string(),
    segments: z.array(z.object({ source: z.enum(['microphone', 'system']), label: z.enum(['Microphone', 'System audio']), startMs: z.number().nonnegative(), endMs: z.number().nonnegative(), text: z.string(), createdAt: z.string().datetime() })),
    summary: z.discriminatedUnion('status', [z.object({ status: z.literal('unavailable'), reason: z.string() }), z.object({ status: z.literal('available'), text: z.string(), providerID: z.string(), modelID: z.string(), transcriptRevision: z.string(), createdAt: z.string().datetime() })]),
});
export type Meeting = z.infer<typeof meetingSchema>;
export type CaptureMode = 'system-and-microphone' | 'microphone';
export type AudioSource = 'microphone' | 'system';
export const meetingsSupported = () => isElectronShell() && hasDesktopInvoke() && isDesktopLocalOriginActive();
const readinessSchema = z.object({ available: z.boolean(), modelId: z.string(), reasonCode: z.string().optional() });
export type MeetingReadiness = z.infer<typeof readinessSchema>;
type CreateMeetingArgs = { title: string; calendarEventId?: string };

// Native main enforces trusted local frame/runtime authorization independently.
async function meetingCommand(command: string, args?: Parameters<typeof invokeDesktop>[1]) {
    if (!meetingsSupported()) throw new Error('meeting_unsupported');
    return invokeDesktop(command, args);
}
export const listMeetings = async () => z.object({ meetings: z.array(meetingSchema), readiness: readinessSchema, capture: z.object({ systemAudioSupported: z.boolean(), systemAudioValidation: z.literal('pending') }), warnings: z.array(z.object({ id: z.string().uuid(), code: z.enum(['invalid_record', 'not_found', 'unsafe_storage']), message: z.string() })).default([]) }).parse(await meetingCommand('desktop_meeting_list'));
export const meetingReadiness = async () => readinessSchema.parse(await meetingCommand('desktop_meeting_readiness'));
export const createMeeting = async (title: string, calendarEventId?: string) => {
    const args: CreateMeetingArgs = { title };
    if (calendarEventId) args.calendarEventId = calendarEventId;
    return meetingSchema.parse(await meetingCommand('desktop_meeting_create', args));
};
export const getMeeting = async (id: string) => meetingSchema.parse(await meetingCommand('desktop_meeting_get', { id }));
export const renameMeeting = async (id: string, title: string) => meetingSchema.parse(await meetingCommand('desktop_meeting_rename', { id, title }));
export const saveMeetingNotes = async (id: string, notes: string) => meetingSchema.parse(await meetingCommand('desktop_meeting_notes', { id, notes }));
export const changeMeetingCapture = async (action: 'pause' | 'resume' | 'stop', id: string) => meetingSchema.parse(await meetingCommand(`desktop_meeting_${action}`, { id }));
export const interruptMeeting = async (id: string) => meetingSchema.nullable().parse(await meetingCommand('desktop_meeting_interrupt', { id, reason: 'capture-error' }));
export const startMeeting = async (id: string, mode: CaptureMode) => meetingSchema.extend({ capture: z.object({ mode: z.enum(['system-and-microphone', 'microphone']), degraded: z.boolean(), systemAudioValidation: z.literal('pending'), systemAudioSupported: z.boolean() }) }).parse(await meetingCommand('desktop_meeting_start', { id, mode, consent: true }));
export const sendMeetingChunk = async (id: string, source: AudioSource, startMs: number, endMs: number, pcm: number[]) => meetingSchema.parse(await meetingCommand('desktop_meeting_chunk', { id, source, startMs, endMs, pcm }));

const disclosureSchema = z.object({ data: z.literal('transcript-only'), cost: z.literal('unknown'), subscriptionCoverage: z.literal('unknown') });
const modelChoiceSchema = z.object({ model: z.string(), providerID: z.string(), modelID: z.string(), name: z.string() });
const summaryChoicesSchema = z.object({ available: z.boolean(), models: z.array(modelChoiceSchema), disclosure: disclosureSchema, reasonCode: z.string().optional(), reason: z.string().optional() });
const summaryApprovalSchema = summaryChoicesSchema.extend({ available: z.literal(true), model: z.string(), providerID: z.string(), modelID: z.string(), approvalToken: z.string(), transcriptRevision: z.string(), expiresAt: z.number() });
export type SummaryChoices = z.infer<typeof summaryChoicesSchema>;
export type SummaryApproval = z.infer<typeof summaryApprovalSchema>;
export const listSummaryModels = async (id: string) => summaryChoicesSchema.parse(await meetingCommand('desktop_meeting_prepare_summary', { id }));
export const prepareMeetingSummary = async (id: string, model: string) => summaryApprovalSchema.parse(await meetingCommand('desktop_meeting_prepare_summary', { id, model }));
export const generateMeetingSummary = async (id: string, approval: SummaryApproval) => meetingSchema.parse(await meetingCommand('desktop_meeting_generate_summary', { id, model: approval.model, approvalToken: approval.approvalToken, approved: true }));

import { z } from 'zod';

// autoStart asks the workspace to create and start recording in one step. It only
// takes effect when the one-time recording acknowledgement was already given and
// the local model is ready; otherwise the normal dialog opens instead.
export const meetingLaunchSchema = z.object({
    title: z.string(),
    calendarEventId: z.string().optional(),
    autoStart: z.boolean().optional(),
    meetingId: z.string().optional(),
    openLog: z.boolean().optional(),
    directory: z.string().optional(),
});
export const MEETING_WORKSPACE_EVENT = 'open-carter:meeting-workspace';
export function openMeetingWorkspace(seed: z.infer<typeof meetingLaunchSchema> = { title: '' }) {
    window.dispatchEvent(new CustomEvent(MEETING_WORKSPACE_EVENT, { detail: seed }));
}

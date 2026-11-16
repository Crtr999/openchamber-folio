import type { HomeCalendar, HomeNotionStatus } from '@/lib/personal-home';

export type HomeSourceEvidence = {
    supported: boolean;
    blocked: boolean;
    networkBlocked: boolean;
    notion: HomeNotionStatus | null;
    calendar: HomeCalendar | null;
    notionFailed: boolean;
    calendarFailed: boolean;
};

/** Home results are observations, not proof of a current provider session or freshness. */
export function homeSourceStates(evidence: HomeSourceEvidence) {
    const { supported, blocked, networkBlocked, notion, calendar, notionFailed, calendarFailed } = evidence;
    if (!supported) return { notion: 'unsupported', calendar: 'unsupported' } as const;
    return {
        notion: blocked || networkBlocked ? 'blocked' : notionFailed ? 'failed' : notion?.signingIn ? 'signingIn' : notion ? notion.connected ? 'savedConnection' : 'disconnected' : 'unknown',
        calendar: calendarFailed || calendar?.error ? 'failed' : calendar?.access === 'connected' ? 'permissionGranted' : calendar?.access === 'not-connected' ? 'permissionRequired' : calendar?.access === 'unsupported' ? 'unsupported' : 'unknown',
    } as const;
}

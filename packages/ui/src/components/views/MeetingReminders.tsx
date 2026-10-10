import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { meetingsSupported } from '@/lib/meetings/contract';
import { meetingCapture } from '@/lib/meetings/capture';
import { openMeetingWorkspace } from '@/lib/meetings/workspace';
import { personalHomeSupported, readHomeCalendar, type HomeCalendarEvent } from '@/lib/personal-home';

// Calendar-driven meeting prompts. Apple Calendar is read every few minutes;
// shortly before a timed event starts (or just after), a card asks whether to
// record it. Yes starts meeting notes titled after the event and linked to it.
const LEAD_MS = 2 * 60_000;
const GRACE_MS = 5 * 60_000;
const REFRESH_MS = 5 * 60_000;
const PROMPTED_KEY = 'open-carter:meeting-reminders';

const readPrompted = (): Record<string, number> => {
    try { return JSON.parse(window.localStorage.getItem(PROMPTED_KEY) ?? '{}') as Record<string, number>; } catch { return {}; }
};
const writePrompted = (value: Record<string, number>) => {
    try {
        const cutoff = Date.now() - 2 * 86_400_000;
        window.localStorage.setItem(PROMPTED_KEY, JSON.stringify(Object.fromEntries(Object.entries(value).filter(([, at]) => at > cutoff))));
    } catch { /* convenience only */ }
};
const keyOf = (event: HomeCalendarEvent) => `${event.id}@${event.start}`;

export function MeetingReminders() {
    const { t, locale } = useI18n();
    const enabled = meetingsSupported() && personalHomeSupported();
    const [events, setEvents] = React.useState<HomeCalendarEvent[]>([]);
    const [prompt, setPrompt] = React.useState<HomeCalendarEvent | null>(null);
    const [now, setNow] = React.useState(() => Date.now());

    React.useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        const load = () => {
            readHomeCalendar().then((calendar) => {
                if (!cancelled && calendar.access === 'connected') setEvents(calendar.events.filter((event) => !event.allDay));
            }).catch(() => { /* calendar unavailable: no prompts */ });
        };
        load();
        const timer = setInterval(load, REFRESH_MS);
        window.addEventListener('focus', load);
        return () => { cancelled = true; clearInterval(timer); window.removeEventListener('focus', load); };
    }, [enabled]);

    React.useEffect(() => {
        if (!enabled) return;
        const timer = setInterval(() => setNow(Date.now()), 15_000);
        return () => clearInterval(timer);
    }, [enabled]);

    React.useEffect(() => {
        if (!enabled || prompt) return;
        if (!['idle', 'error'].includes(meetingCapture.getSnapshot().phase)) return;
        const prompted = readPrompted();
        const due = events
            .filter((event) => {
                const start = Date.parse(event.start);
                return Number.isFinite(start) && start - now <= LEAD_MS && now - start <= GRACE_MS && !prompted[keyOf(event)];
            })
            .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
        if (!due) return;
        prompted[keyOf(due)] = Date.now();
        writePrompted(prompted);
        setPrompt(due);
        try {
            if (typeof Notification !== 'undefined' && Notification.permission !== 'denied') {
                const notify = () => {
                    const notification = new Notification(due.title, { body: t('meeting.reminder.notification'), silent: false });
                    notification.onclick = () => { window.focus(); };
                };
                if (Notification.permission === 'granted') notify();
                else void Notification.requestPermission().then((permission) => { if (permission === 'granted') notify(); });
            }
        } catch { /* the in-app card is enough */ }
    }, [enabled, events, now, prompt, t]);

    // A prompt that is no longer relevant goes away by itself.
    React.useEffect(() => {
        if (prompt && now - Date.parse(prompt.start) > GRACE_MS * 2) setPrompt(null);
    }, [now, prompt]);

    // Once a recording is running the question is answered.
    const recording = !['idle', 'error'].includes(meetingCapture.getSnapshot().phase);
    if (!enabled || !prompt || recording) return null;
    const start = Date.parse(prompt.start);
    const minutes = Math.round((start - now) / 60_000);
    const when = minutes > 0 ? t('meeting.reminder.startsIn', { minutes }) : minutes === 0 ? t('meeting.reminder.startingNow') : t('meeting.reminder.started', { minutes: -minutes });
    return <div role="alertdialog" aria-label={prompt.title} className="oc-reminder app-region-no-drag fixed right-5 top-16 z-[56] w-[320px] rounded-xl border border-border/80 bg-[var(--surface-elevated,var(--background))] p-3.5 shadow-[0_16px_48px_-12px_rgba(0,0,0,0.6)]">
        <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-red-400"><Icon name="calendar" className="size-4.5" /></div>
            <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-semibold text-foreground" title={prompt.title}>{prompt.title}</p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">{when} · {new Date(start).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })}</p>
                <p className="mt-1.5 text-[12.5px] text-foreground/85">{t('meeting.reminder.question')}</p>
            </div>
            <button type="button" aria-label={t('meeting.ui.dismiss')} onClick={() => setPrompt(null)} className="oc-press -mr-1 -mt-1 flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground"><Icon name="close" className="size-3.5" /></button>
        </div>
        <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="ghost" className="oc-press h-8" onClick={() => setPrompt(null)}>{t('meeting.reminder.notNow')}</Button>
            <Button size="sm" className="oc-press h-8 gap-1.5" onClick={() => { const event = prompt; setPrompt(null); openMeetingWorkspace({ title: event.title, calendarEventId: event.id, autoStart: true }); }}>
                <Icon name="mic" className="size-3.5" />{t('meeting.reminder.record')}
            </Button>
        </div>
    </div>;
}

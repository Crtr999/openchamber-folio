import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { meetingsSupported } from '@/lib/meetings/contract';
import { openMeetingWorkspace } from '@/lib/meetings/workspace';
import { showPill } from '@/lib/pill';
import {
    moveHomeTask, personalHomeSupported, readHomeBoard, readHomeCalendar,
    type HomeCalendarEvent, type HomeNotionBoard,
} from '@/lib/personal-home';

type Row = HomeNotionBoard['rows'][number];
const DONE = /done|complete|finish|archiv/i;
const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
// Notion date-only values are calendar days; datetimes are converted to the local day.
const dueKey = (row: Row) => {
    if (!row.due) return null;
    return row.due.isDatetime ? dayKey(new Date(row.due.start)) : row.due.start.slice(0, 10);
};

/**
 * "What's on today?" — one card with today's meetings and the tasks that are
 * due or overdue. It fills in row by row, a meeting can be recorded from here,
 * and ticking a task moves it to the board's done column and lets the row go.
 */
export function TodayCard({ onClose }: { onClose: (after?: () => void) => void }) {
    const { t, locale } = useI18n();
    const [events, setEvents] = React.useState<HomeCalendarEvent[] | null>(null);
    const [board, setBoard] = React.useState<HomeNotionBoard | null>(null);
    const [calendarNote, setCalendarNote] = React.useState('');
    const [boardNote, setBoardNote] = React.useState('');
    const [ticking, setTicking] = React.useState<Set<string>>(new Set());
    const [gone, setGone] = React.useState<Set<string>>(new Set());
    const supported = personalHomeSupported();

    React.useEffect(() => {
        if (!supported) return;
        let cancelled = false;
        readHomeCalendar().then((calendar) => {
            if (cancelled) return;
            if (calendar.access !== 'connected') { setEvents([]); setCalendarNote(t('today.calendarOff')); return; }
            const today = dayKey(new Date());
            setEvents(calendar.events
                .filter((event) => dayKey(new Date(event.start)) === today || (event.allDay && event.start.slice(0, 10) === today))
                .sort((a, b) => Number(b.allDay) - Number(a.allDay) || Date.parse(a.start) - Date.parse(b.start)));
        }).catch(() => { if (!cancelled) { setEvents([]); setCalendarNote(t('today.calendarError')); } });
        readHomeBoard().then((next) => { if (!cancelled) setBoard(next); })
            .catch(() => { if (!cancelled) { setBoard(null); setBoardNote(t('today.tasksError')); } });
        return () => { cancelled = true; };
    }, [supported, t]);

    const today = dayKey(new Date());
    const doneColumn = board?.columns.find((column) => DONE.test(column)) ?? null;
    const tasks = React.useMemo(() => {
        if (!board) return { due: [] as Row[], overdue: [] as Row[] };
        const open = board.rows.filter((row) => !DONE.test(row.status ?? ''));
        return {
            overdue: open.filter((row) => { const key = dueKey(row); return key !== null && key < today; }),
            due: open.filter((row) => dueKey(row) === today),
        };
    }, [board, today]);

    const tick = (row: Row) => {
        if (!doneColumn || ticking.has(row.url)) return;
        setTicking((current) => new Set(current).add(row.url));
        moveHomeTask(row.url, doneColumn).then(() => {
            showPill(t('today.taskDone', { title: row.title || t('home.untitled') }));
            window.dispatchEvent(new CustomEvent('open-carter:tasks-changed'));
            window.setTimeout(() => setGone((current) => new Set(current).add(row.url)), 760);
        }).catch(() => {
            setTicking((current) => { const next = new Set(current); next.delete(row.url); return next; });
            showPill(t('today.taskFailed'), 'error');
        });
    };

    const now = Date.now();
    const time = (iso: string) => new Date(iso).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
    const loading = events === null || (board === null && !boardNote && supported);
    const visibleTasks = [...tasks.overdue, ...tasks.due].filter((row) => !gone.has(row.url));
    const meetingCount = events?.filter((event) => !event.allDay).length ?? 0;

    if (!supported) {
        return <div className="p-6 text-[13px] text-muted-foreground">{t('today.unsupported')}</div>;
    }

    return <div className="oc-fade-in flex min-h-0 flex-1 flex-col">
        <div className="flex items-end justify-between gap-3 border-b border-border/60 px-5 pb-3 pt-4">
            <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{new Date().toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
                <h2 className="mt-0.5 text-[20px] font-semibold tracking-tight text-foreground">{t('today.title')}</h2>
            </div>
            {!loading ? <p className="pb-0.5 text-[12px] text-muted-foreground">{t('today.counts', { meetings: meetingCount, tasks: visibleTasks.length })}</p> : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {loading ? <div className="space-y-3 px-2 py-2">{[70, 85, 60, 78].map((width, index) => <div key={index} className="oc-shimmer h-3.5 rounded" style={{ width: `${width}%` }} />)}</div> : <>
                <p className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">{t('today.meetings')}</p>
                <div className="oc-stream space-y-0.5">
                    {events && events.length ? events.map((event) => {
                        const start = Date.parse(event.start);
                        const end = Date.parse(event.end);
                        const past = !event.allDay && end < now;
                        const live = !event.allDay && start <= now && now <= end;
                        return <div key={`${event.id}:${event.start}`} className={cn('flex items-center gap-3 rounded-lg px-2 py-1.5', live && 'bg-red-500/[0.07]', past && 'opacity-50')}>
                            <span className="w-[64px] shrink-0 text-[12px] tabular-nums text-muted-foreground">{event.allDay ? t('home.allDay') : time(event.start)}</span>
                            <span className="min-w-0 flex-1">
                                <span className="block truncate text-[13.5px] font-medium text-foreground">{event.title}</span>
                                <span className="block truncate text-[11px] text-muted-foreground">{event.calendarTitle}{live ? ` · ${t('today.now')}` : ''}</span>
                            </span>
                            {!event.allDay && !past && meetingsSupported() ? <button type="button"
                                onClick={() => onClose(() => openMeetingWorkspace({ title: event.title, calendarEventId: event.id, autoStart: true }))}
                                className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border/70 px-2.5 text-[12px] text-muted-foreground hover:border-red-500/40 hover:text-foreground">
                                <span className="size-1.5 rounded-full bg-red-500" />{t('today.record')}
                            </button> : null}
                        </div>;
                    }) : <p className="px-2 py-1.5 text-[12.5px] text-muted-foreground">{calendarNote || t('today.noMeetings')}</p>}
                </div>
                <p className="px-2 pb-1 pt-4 text-[11px] font-medium text-muted-foreground">{t('today.tasks')}</p>
                <div className="oc-stream space-y-0.5">
                    {visibleTasks.length ? visibleTasks.map((row) => {
                        const overdue = tasks.overdue.includes(row);
                        const done = ticking.has(row.url);
                        return <div key={row.url} className={cn('group flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-interactive-hover/60', done && 'oc-row-done')}>
                            <button type="button" role="checkbox" aria-checked={done} disabled={!doneColumn || done}
                                aria-label={t('today.markDone', { title: row.title || t('home.untitled') })}
                                title={doneColumn ? t('today.markDoneHint', { column: doneColumn }) : t('today.noDoneColumn')}
                                onClick={() => tick(row)}
                                className={cn('flex size-[18px] shrink-0 items-center justify-center rounded-full border transition-colors',
                                    done ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-border hover:border-emerald-500/70')}>
                                {done ? <Icon name="check" className="oc-saved-tick size-3" /> : null}
                            </button>
                            <span className={cn('min-w-0 flex-1 truncate text-[13.5px] text-foreground', done && 'text-muted-foreground line-through')}>{row.title || t('home.untitled')}</span>
                            <span className={cn('shrink-0 text-[11px]', overdue ? 'text-red-400' : 'text-muted-foreground')}>{overdue ? t('today.overdue') : t('today.dueToday')}</span>
                            <a href={row.url} target="_blank" rel="noreferrer" aria-label={t('today.openInNotion')} title={t('today.openInNotion')}
                                className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"><Icon name="external-link" className="size-3.5" /></a>
                        </div>;
                    }) : <p className="px-2 py-1.5 text-[12.5px] text-muted-foreground">{boardNote || (board ? t('today.allClear') : t('today.tasksError'))}</p>}
                </div>
            </>}
        </div>
    </div>;
}

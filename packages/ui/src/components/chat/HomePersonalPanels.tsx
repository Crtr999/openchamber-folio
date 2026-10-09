import React from 'react';
import { HomeTaskComposer } from './HomeTaskComposer';
import { openMeetingWorkspace } from '@/lib/meetings/workspace';
import { toast } from 'sonner';
import { HomeTaskBoard } from './HomeTaskBoard';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useEnterpriseMode, useEnterprisePolicyStore } from '@/stores/useEnterprisePolicyStore';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import type { Session } from '@/lib/opencode/model';
import {
    personalHomeSupported, readHomeNotionStatus, readHomeBoard, readHomeHabits,
    connectHomeNotion, configureHomeNotion, disconnectHomeNotion, moveHomeTask,
    createHomeTask, renameHomeTask, deleteHomeTask,
    toggleHomeHabit, startHomeDay, readHomeCalendar, saveHomeEvent, exportHomeChat,
    type HomeNotionStatus, type HomeNotionBoard, type HomeHabits, type HomeCalendar, type HomeCalendarEvent,
} from '@/lib/personal-home';

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const localTime = (value: Date) => { const d = new Date(value.getTime() - value.getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
const message = (error: Error | string) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
const toNotionUrl = (id: string) => id.startsWith('https://') ? id : `https://www.notion.so/${id.replaceAll('-', '')}`;

export const HomeChatExport: React.FC<{ session: Session }> = ({ session }) => {
    const { t } = useI18n();
    const blocked = useEnterpriseMode();
    const [open, setOpen] = React.useState(false);
    const [status, setStatus] = React.useState<HomeNotionStatus | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const [saved, setSaved] = React.useState(false);
    if (!personalHomeSupported() || blocked) return null;
    const show = async () => {
        setOpen(true); setError(''); setSaved(false); setStatus(null); setBusy(true);
        try { setStatus(await readHomeNotionStatus()); } catch (e) { setError(message(e instanceof Error ? e : String(e))); } finally { setBusy(false); }
    };
    const save = async () => {
        setBusy(true); setError('');
        try { await exportHomeChat(session, { user: t('contextSidebar.stats.user'), assistant: t('contextSidebar.stats.assistant') }); setSaved(true); }
        catch (e) { setError(message(e instanceof Error ? e : String(e))); } finally { setBusy(false); }
    };
    return <>
        <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" aria-label={t('home.saveChat')} title={t('home.saveChat')} onClick={() => void show()}><Icon name="save-3" className="size-3.5" /></Button>
        <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>{t('home.saveChat')}</DialogTitle><DialogDescription>{t('home.exportDescription')}</DialogDescription></DialogHeader>
            <p className="text-sm font-medium">{session.title}</p>
            {status?.connected && <p className="text-xs text-muted-foreground">{t('home.destination')}: <a className="underline" href={toNotionUrl(status.destination)} target="_blank" rel="noreferrer">{t('home.notionHome')}</a></p>}
            {status && !status.connected && <p className="text-sm text-muted-foreground">{t('home.connectFirst')}</p>}
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            {saved && <p role="status" className="text-sm text-primary">{t('home.saved')}</p>}
            <Button type="button" disabled={busy || !status?.connected || saved} onClick={() => void save()}>{busy ? t('common.loading') : t('home.saveChat')}</Button>
        </DialogContent></Dialog>
    </>;
};

type PersonalPanels = { tasks: React.ReactNode; calendar: React.ReactNode; habits: React.ReactNode };
export const HomePersonalPanels: React.FC<{ children: (panels: PersonalPanels) => React.ReactNode }> = ({ children }) => {
    const { t, locale } = useI18n();
    const blocked = useEnterpriseMode();
    const networkBlocked = useEnterprisePolicyStore((state) => state.networkAccessBlocked);
    const [runtime, setRuntime] = React.useState(getRuntimeKey);
    React.useEffect(() => subscribeRuntimeEndpointChanged(() => setRuntime(getRuntimeKey())), []);
    const [status, setStatus] = React.useState<HomeNotionStatus | null>(null);
    const [board, setBoard] = React.useState<HomeNotionBoard | null>(null);
    const [habits, setHabits] = React.useState<HomeHabits | null>(null);
    const [calendar, setCalendar] = React.useState<HomeCalendar | null>(null);
    const [errors, setErrors] = React.useState<Record<string, string>>({});
    const [busy, setBusy] = React.useState('');
    const [settingsOpen, setSettingsOpen] = React.useState(false);
    const [config, setConfig] = React.useState({ board: '', habits: '', destination: '' });
    const [eventOpen, setEventOpen] = React.useState(false);
    const [event, setEvent] = React.useState<{ id?: string; title: string; start: string; end: string; calendarId: string }>({ title: '', start: '', end: '', calendarId: '' });
    const [taskDraft, setTaskDraft] = React.useState('');
    const [editingTask, setEditingTask] = React.useState('');
    const [editDraft, setEditDraft] = React.useState('');
    const [confirmTask, setConfirmTask] = React.useState('');
    const [notice, setNotice] = React.useState('');
    const generation = React.useRef(0);
    const boardRevision = React.useRef(0);
    const movePending = React.useRef(false);
    const [pendingPage, setPendingPage] = React.useState('');
    const supported = personalHomeSupported();
    const notionAllowed = supported && !blocked && !networkBlocked;
    const [day, setDay] = React.useState(today);
    React.useEffect(() => {
        const update = () => setDay(today());
        const timer = window.setInterval(update, 60000);
        document.addEventListener('visibilitychange', update);
        return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', update); };
    }, []);
    React.useEffect(() => {
        if (!confirmTask) return;
        const timer = window.setTimeout(() => setConfirmTask(''), 4000);
        return () => window.clearTimeout(timer);
    }, [confirmTask]);
    const fail = React.useCallback((key: string, error: Error | string) => setErrors((previous) => ({ ...previous, [key]: message(error) })), []);
    const clear = (key: string) => setErrors((previous) => ({ ...previous, [key]: '' }));
    const refreshNotion = React.useCallback(async (version = generation.current) => {
        if (!notionAllowed) return;
        const revision = boardRevision.current;
        try {
            const next = await readHomeNotionStatus();
            if (version !== generation.current) return;
            setStatus(next);
            setErrors((previous) => ({ ...previous, notion: '' }));
            if (!next.connected) { setBoard(null); setHabits(null); return; }
            const result = await Promise.allSettled([readHomeBoard(), readHomeHabits(day)]);
            if (version !== generation.current) return;
            if (revision === boardRevision.current && result[0].status === 'fulfilled') { setBoard(result[0].value); setErrors((previous) => ({ ...previous, board: '' })); } else if (result[0].status === 'rejected') fail('board', result[0].reason);
            if (result[1].status === 'fulfilled') { setHabits(result[1].value); setErrors((previous) => ({ ...previous, habits: '' })); } else fail('habits', result[1].reason);
        } catch (e) { if (version === generation.current) fail('notion', e instanceof Error ? e : String(e)); }
    }, [notionAllowed, day, fail]);
    const refreshCalendar = React.useCallback(async (connect = false, version = generation.current) => {
        if (!supported) return;
        try {
            const next = await readHomeCalendar(connect);
            if (version !== generation.current) return;
            setCalendar(next); if (next.error) fail('calendar', next.error); else setErrors((previous) => ({ ...previous, calendar: '' }));
        } catch (e) { if (version === generation.current) fail('calendar', e instanceof Error ? e : String(e)); }
    }, [supported, fail]);
    // Tasks added elsewhere (e.g. meeting action items) refresh the board.
    React.useEffect(() => {
        const onChange = () => { void refreshNotion(); };
        window.addEventListener('open-carter:tasks-changed', onChange);
        return () => window.removeEventListener('open-carter:tasks-changed', onChange);
    }, [refreshNotion]);
    React.useEffect(() => {
        const version = ++generation.current;
        boardRevision.current += 1; movePending.current = false; setPendingPage(''); setBusy('');
        setStatus(null); setBoard(null); setHabits(null); setCalendar(null); setErrors({});
        void refreshNotion(version); void refreshCalendar(false, version);
        return () => { generation.current += 1; };
    }, [refreshNotion, refreshCalendar, runtime]);
    const run = async (key: string, action: () => Promise<void>) => {
        if (busy) return;
        setBusy(key); clear(key); setNotice('');
        try { await action(); } catch (e) { fail(key, e instanceof Error ? e : String(e)); } finally { setBusy(''); }
    };
    const addTask = () => run('board', async () => { await createHomeTask(taskDraft.trim()); setTaskDraft(''); setBoard(await readHomeBoard()); });
    const moveTask = async (page: string, destination: string) => {
        const row = board?.rows.find((item) => item.url === page);
        if (!notionAllowed || busy || movePending.current || !row || !board?.columns.includes(destination) || row.status === destination) return;
        const version = generation.current;
        const owner = getRuntimeKey();
        movePending.current = true; boardRevision.current += 1;
        setBusy('board'); setPendingPage(page); clear('board');
        setBoard((current) => current ? { ...current, rows: current.rows.map((item) => item.url === page ? { ...item, status: destination } : item) } : current);
        try {
            await moveHomeTask(page, destination);
            if (version === generation.current && owner === getRuntimeKey()) toast.success(t('home.taskMoved', { status: destination }));
        } catch (error) {
            if (version !== generation.current || owner !== getRuntimeKey()) return;
            setBoard((current) => current ? { ...current, rows: current.rows.map((item) => item.url === page ? { ...item, status: row.status } : item) } : current);
            toast.error(t('home.taskMoveFailed'), { description: message(error instanceof Error ? error : String(error)) });
        } finally {
            if (version === generation.current && owner === getRuntimeKey()) { boardRevision.current += 1; movePending.current = false; setPendingPage(''); setBusy(''); }
        }
    };
    const saveTask = async (page: string) => {
        if (editingTask !== page) return;
        const title = editDraft.trim();
        if (!title) { setEditingTask(''); return; }
        await run('board', async () => { await renameHomeTask(page, title); setEditingTask((current) => (current === page ? '' : current)); setBoard(await readHomeBoard()); });
    };
    const openEvent = (existing?: HomeCalendarEvent) => {
        const start = new Date(); start.setMinutes(0, 0, 0); start.setHours(start.getHours() + 1);
        setEvent(existing ? { id: existing.id, title: existing.title, start: localTime(new Date(existing.start)), end: localTime(new Date(existing.end)), calendarId: existing.calendarId }
            : { id: undefined, title: '', start: localTime(start), end: localTime(new Date(start.getTime() + 3600000)), calendarId: calendar?.calendars.find((item) => item.writable)?.id ?? '' });
        clear('event'); setEventOpen(true);
    };
    const errorText = (key: string) => errors[key] ? <p role="alert" className="oc-home-empty text-destructive">{errors[key]}</p> : null;
    const stateText = !supported ? t('home.desktopOnly') : blocked || networkBlocked ? t('home.blocked') : status?.signingIn ? t('home.finishConnect') : status?.connected ? '' : t('home.connectFirst');
    return <>
        {children({ tasks: <section className="oc-home-task-panel">
            <div className="oc-home-card-heading oc-home-task-heading">
                <h2 className="flex min-w-0 items-center gap-2"><Icon name="checkbox" className="size-3.5 shrink-0" /><span className="truncate">{t('home.tasks')}</span></h2>
                {board && notionAllowed && <HomeTaskComposer value={taskDraft} onChange={setTaskDraft} onSubmit={() => void addTask()} disabled={Boolean(busy)} />}
                <span className="ml-auto flex shrink-0 gap-1">
                    {notionAllowed && <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={t('home.refresh')} title={t('home.refresh')} disabled={Boolean(busy)} onClick={() => void run('notion', () => refreshNotion())}><Icon name="refresh" className="size-3.5" /></Button>}
                    {notionAllowed && status?.connected && <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={t('home.connections')} onClick={() => { setConfig({ board: status.board, habits: status.habits, destination: status.destination }); setSettingsOpen(true); }}><Icon name="settings-3" className="size-3.5" /></Button>}
                    {notionAllowed && status && !status.connected && <Button type="button" variant="ghost" size="sm" disabled={Boolean(busy) || status.signingIn} onClick={() => void run('notion', async () => { await connectHomeNotion(); await refreshNotion(); })}>{t('home.connectNotion')}</Button>}
                </span>
            </div>
            {stateText && <p className="oc-home-empty">{stateText}</p>}{errorText('notion')}{errorText('board')}{notice && <p role="status" className="oc-home-empty text-primary">{notice}</p>}
            {board && notionAllowed && <>
                <HomeTaskBoard board={board} disabled={Boolean(busy)} pendingPage={pendingPage} onMove={(page, destination) => void moveTask(page, destination)} renderTask={(row) => <>
                        {editingTask === row.url
                            ? <Input autoFocus value={editDraft} disabled={Boolean(busy)} aria-label={t('home.editTask')} onChange={(event) => setEditDraft(event.target.value)} onBlur={() => void saveTask(row.url)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void saveTask(row.url); } if (event.key === 'Escape') setEditingTask(''); }} />
                            : <div className="flex items-center gap-1">
                                <a href={row.url} target="_blank" rel="noreferrer" className="block min-w-0 flex-1 truncate text-xs leading-relaxed hover:underline">{row.title || t('home.untitled')}</a>
                                <Button type="button" variant="ghost" size="icon" className="size-5 shrink-0" aria-label={t('home.editTask')} title={t('home.editTask')} disabled={Boolean(busy)} onClick={() => { setEditingTask(row.url); setEditDraft(row.title ?? ''); }}><Icon name="pencil" className="size-3" /></Button>
                                {confirmTask === row.url
                                    ? <Button type="button" variant="ghost" size="sm" className="h-5 px-1.5 text-[10px]" disabled={Boolean(busy)} onClick={() => void run('board', async () => { await deleteHomeTask(row.url); setConfirmTask(''); setNotice(t('home.taskDeleted')); setBoard(await readHomeBoard()); })}>{t('home.deleteTaskConfirm')}</Button>
                                    : <Button type="button" variant="ghost" size="icon" className="size-5 shrink-0" aria-label={t('home.deleteTask')} title={t('home.deleteTask')} disabled={Boolean(busy)} onClick={() => setConfirmTask(row.url)}><Icon name="delete-bin" className="size-3" /></Button>}
                            </div>}
                    </>} />

            </>}
            {board?.limited && <p className="oc-home-empty">{t('home.boardLimit')}</p>}
        </section>, calendar: <section>
            <h2 className="oc-home-card-heading"><Icon name="calendar-schedule" className="size-3.5" />{t('home.calendar')}<span className="ml-auto flex gap-1">
                <Button type="button" variant="ghost" size="sm" onClick={() => openMeetingWorkspace()}>{t('meeting.launch')}</Button>
                {calendar?.access === 'connected' && <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={t('home.refresh')} disabled={Boolean(busy)} onClick={() => void run('calendar', () => refreshCalendar())}><Icon name="refresh" className="size-3.5" /></Button>}
                {calendar?.calendars.some((item) => item.writable) && <Button type="button" variant="ghost" size="sm" onClick={() => openEvent()}>{t('home.newEvent')}</Button>}
            </span></h2>
            {errorText('calendar')}
            {!supported || calendar?.access === 'unsupported' ? <p className="oc-home-empty">{t('home.macOnly')}</p> : calendar?.access === 'not-connected' ? <Button type="button" variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => void run('calendar', () => refreshCalendar(true))}>{t('home.connectCalendar')}</Button> : !calendar ? <p className="oc-home-empty">{t('common.loading')}</p> : <div className="oc-home-agenda">
                {calendar.events.slice(0, 12).map((item) => <div key={`${item.id}:${item.start}`} className="flex min-w-0 items-center gap-1"><Button type="button" variant="ghost" className="oc-home-event min-w-0 flex-1" disabled={!item.writable} onClick={() => openEvent(item)}>
                    <span className="oc-home-event-time">{new Date(item.start).toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' })} · {item.allDay ? t('home.allDay') : new Date(item.start).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })}</span>
                    <span className="oc-home-event-title">{item.title || t('home.untitled')}</span><span className="oc-home-row-detail">{item.calendarTitle}</span>
                </Button><Button type="button" variant="ghost" size="xs" onClick={() => openMeetingWorkspace({ title: item.title, calendarEventId: item.id, autoStart: true })}>{t('meeting.launch')}</Button></div>)}
                {!calendar.events.length && <p className="oc-home-empty">{t('home.noEvents')}</p>}
            </div>}
        </section>, habits: <section>
            <h2 className="oc-home-card-heading"><Icon name="check" className="size-3.5" />{t('home.habits')}<span className="ml-auto text-[10px] tabular-nums">{habits?.page ? `${habits.items.filter((item) => item.checked).length} / ${habits.items.length}` : day}</span></h2>
            {errorText('habits')}
            {habits && notionAllowed ? habits.page ? <div className="oc-home-habits">{habits.items.map((item) => <label key={item.name} className="flex min-w-0 items-center gap-2 py-1.5 text-xs"><Checkbox checked={item.checked} ariaLabel={item.name} disabled={Boolean(busy)} onChange={(checked) => void run('habits', async () => { if (habits.day !== today()) { setDay(today()); return; } await toggleHomeHabit(habits.page!, item.name, checked); setHabits(await readHomeHabits(today())); })} /><span className={item.checked ? 'truncate text-muted-foreground line-through' : 'truncate'}>{item.name}</span></label>)}</div> : <><p className="oc-home-empty">{t('home.noDay')}</p><Button type="button" variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => void run('habits', async () => setHabits(await startHomeDay(today())))}>{t('home.startDay')}</Button></> : <p className="oc-home-empty">{stateText || t('common.loading')}</p>}
        </section> })}
        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}><DialogContent><DialogHeader><DialogTitle>{t('home.connections')}</DialogTitle><DialogDescription>{t('home.connectionDescription')}</DialogDescription></DialogHeader>
            {(['board', 'habits', 'destination'] as const).map((key) => <label key={key} className="space-y-2 text-xs">{t(key === 'board' ? 'home.tasks' : key === 'habits' ? 'home.habits' : 'home.destination')}<Input value={config[key]} onChange={(e) => setConfig({ ...config, [key]: e.target.value })} /></label>)}
            {errorText('config')}<div className="flex justify-between"><Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={() => void run('config', async () => { await disconnectHomeNotion(); setSettingsOpen(false); await refreshNotion(); })}>{t('home.disconnect')}</Button><Button type="button" disabled={Boolean(busy)} onClick={() => void run('config', async () => { await configureHomeNotion(config.board.trim(), config.habits.trim(), config.destination.trim()); setSettingsOpen(false); await refreshNotion(); })}>{t('home.save')}</Button></div>
        </DialogContent></Dialog>
        <Dialog open={eventOpen} onOpenChange={setEventOpen}><DialogContent><DialogHeader><DialogTitle>{event.id ? t('home.editEvent') : t('home.newEvent')}</DialogTitle><DialogDescription>{t('home.eventDescription')}</DialogDescription></DialogHeader>
            <label className="space-y-2 text-xs">{t('home.eventTitle')}<Input value={event.title} onChange={(e) => setEvent({ ...event, title: e.target.value })} /></label>
            <div className="grid grid-cols-2 gap-3">{(['start', 'end'] as const).map((key) => <label key={key} className="space-y-2 text-xs">{t(key === 'start' ? 'home.start' : 'home.end')}<Input type="datetime-local" value={event[key]} onChange={(e) => setEvent({ ...event, [key]: e.target.value })} /></label>)}</div>
            <Select value={event.calendarId} onValueChange={(value) => setEvent({ ...event, calendarId: value })}><SelectTrigger aria-label={t('home.calendar')} className="w-full"><SelectValue>{calendar?.calendars.find((item) => item.id === event.calendarId)?.title}</SelectValue></SelectTrigger><SelectContent>{calendar?.calendars.filter((item) => item.writable).map((item) => <SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>)}</SelectContent></Select>
            {errorText('event')}<Button type="button" disabled={Boolean(busy) || !event.title.trim() || !event.calendarId || !event.start || !event.end || new Date(event.end) <= new Date(event.start)} onClick={() => void run('event', async () => { await saveHomeEvent({ ...event, start: new Date(event.start).toISOString(), end: new Date(event.end).toISOString() }); setEventOpen(false); await refreshCalendar(); })}>{t('home.save')}</Button>
        </DialogContent></Dialog>
    </>;
};

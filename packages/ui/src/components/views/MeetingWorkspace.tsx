import React from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { createMeeting, getMeeting, renameMeeting, listMeetings, meetingReadiness, meetingsSupported, saveMeetingNotes, listSummaryModels, prepareMeetingSummary, generateMeetingSummary, type Meeting, type MeetingReadiness, type SummaryChoices, type SummaryApproval } from '@/lib/meetings/contract';
import { meetingCapture } from '@/lib/meetings/capture';
import { meetingLaunchSchema, MEETING_WORKSPACE_EVENT } from '@/lib/meetings/workspace';
import { MeetingTranscript } from './MeetingTranscript';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { useUIStore } from '@/stores/useUIStore';
import { copyTextToClipboard } from '@/lib/clipboard';
import { createHomeTask, exportMeetingToNotion } from '@/lib/personal-home';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionTabsStore } from '@/stores/useSessionTabsStore';

// The recording acknowledgement is asked once and remembered on this device, so
// starting a meeting is one click. Set to false to ask before every recording.
// You remain responsible for telling participants they are being recorded.
const REMEMBER_CONSENT = true;
const CONSENT_KEY = 'open-carter:meeting-consent';
const MODE_KEY = 'open-carter:meeting-mode';
// Notion-style automatic summaries: after the first explicit, reviewed summary
// the chosen model and its transcript-only disclosure are remembered, and every
// later stopped recording is summarized automatically through the same
// approval-token flow (prepare → generate). Choosing another model asks again.
const SUMMARY_MODEL_KEY = 'open-carter:meeting-summary-model';
const SUMMARY_ACK_KEY = 'open-carter:meeting-summary-ack';
const readFlag = (key: string) => { try { return window.localStorage.getItem(key); } catch { return null; } };
const writeFlag = (key: string, value: string | null) => { try { if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, value); } catch { /* storage is a convenience only */ } };
const storedConsent = () => REMEMBER_CONSENT && readFlag(CONSENT_KEY) === '1';
const storedMode = (): 'system-and-microphone' | 'microphone' => readFlag(MODE_KEY) === 'microphone' ? 'microphone' : 'system-and-microphone';
const rememberedSummaryModel = () => { const model = readFlag(SUMMARY_MODEL_KEY); return model && readFlag(SUMMARY_ACK_KEY) === model ? model : null; };
const tabs = ['summary', 'notes', 'transcript'] as const;
type Tab = typeof tabs[number];
type AutoSummary = { id: string; state: 'running' | 'done' | 'failed' } | null;

const clock = (ms: number) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor(total / 60) % 60;
    const seconds = total % 60;
    return `${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:${String(seconds).padStart(2, '0')}`;
};
const defaultTitle = (locale: string) => `Meeting @${new Date().toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;

/** Elapsed recording time, paused while capture is paused. */
function useElapsed(phase: string, meetingId: string | undefined) {
    const [now, setNow] = React.useState(() => Date.now());
    const state = React.useRef<{ id?: string; accumulated: number; since: number | null }>({ accumulated: 0, since: null });
    if (state.current.id !== meetingId) state.current = { id: meetingId, accumulated: 0, since: null };
    const running = phase === 'recording' || phase === 'pausing';
    if (running && state.current.since === null) state.current.since = Date.now();
    if (!running && state.current.since !== null) { state.current.accumulated += Date.now() - state.current.since; state.current.since = null; }
    React.useEffect(() => {
        if (!running) return;
        const timer = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(timer);
    }, [running]);
    return state.current.accumulated + (state.current.since !== null ? now - state.current.since : 0);
}

/** Five bars that follow the live input level. */
function Waveform({ level, live, className }: { level: number; live: boolean; className?: string }) {
    const [tick, setTick] = React.useState(0);
    React.useEffect(() => {
        if (!live) return;
        const timer = setInterval(() => setTick((value) => value + 1), 130);
        return () => clearInterval(timer);
    }, [live]);
    const strength = live ? Math.min(1, level * 6) : 0;
    return <span aria-hidden className={cn('flex h-4 items-center gap-[2px]', className)}>
        {[0.55, 0.85, 1, 0.75, 0.5].map((weight, index) => {
            const jitter = live ? 0.55 + 0.45 * Math.abs(Math.sin((tick + 1) * (index + 1.7))) : 0;
            const height = 3 + Math.round(13 * Math.max(live ? 0.08 : 0, strength * weight * jitter));
            return <span key={index} className="oc-wave-bar w-[3px] rounded-full bg-current" style={{ height }} />;
        })}
    </span>;
}

/** Light Markdown for summaries: headings, bullets, checkboxes and bold. */
function SummaryText({ text }: { text: string }) {
    const inline = (line: string) => line.split(/(\*\*[^*]+\*\*)/g).map((part, index) => part.startsWith('**') && part.endsWith('**') ? <strong key={index} className="font-semibold text-foreground">{part.slice(2, -2)}</strong> : part);
    return <div className="space-y-1.5 text-[13.5px] leading-relaxed text-foreground/90">
        {text.split('\n').map((raw, index) => {
            const line = raw.trimEnd();
            if (!line.trim()) return <div key={index} className="h-1.5" />;
            const heading = /^(#{1,4})\s+(.*)$/.exec(line.trim());
            if (heading) return <h4 key={index} className={cn('pt-2 font-semibold text-foreground', heading[1].length <= 2 ? 'text-[15.5px]' : 'text-[14px]')}>{inline(heading[2])}</h4>;
            const task = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
            if (task) return <p key={index} className="flex items-start gap-2 pl-1"><Icon name={task[1] === ' ' ? 'checkbox-blank' : 'checkbox'} className="mt-[3px] size-3.5 shrink-0 text-muted-foreground" /><span>{inline(task[2])}</span></p>;
            const bullet = /^(\s*)[-*•]\s+(.*)$/.exec(line);
            if (bullet) return <p key={index} className="flex items-start gap-2" style={{ paddingLeft: 4 + Math.min(3, Math.floor(bullet[1].length / 2)) * 14 }}><span className="mt-[9px] size-1 shrink-0 rounded-full bg-foreground/60" /><span>{inline(bullet[2])}</span></p>;
            const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
            if (numbered) return <p key={index} className="flex items-start gap-2 pl-1"><span className="w-4 shrink-0 text-right text-muted-foreground">{numbered[1]}.</span><span>{inline(numbered[2])}</span></p>;
            return <p key={index}>{inline(line)}</p>;
        })}
    </div>;
}

const transcriptText = (meeting: Meeting, labels: { microphone: string; system: string }) => [...meeting.segments]
    .sort((a, b) => a.startMs - b.startMs)
    .map((segment) => `[${clock(segment.startMs)}] ${segment.source === 'microphone' ? labels.microphone : labels.system}: ${segment.text}`)
    .join('\n');
/** The whole meeting as Markdown: summary, notes, transcript. */
const meetingMarkdown = (meeting: Meeting, locale: string, labels: { microphone: string; system: string; summary: string; notes: string; transcript: string }) => {
    const parts = [`_${new Date(meeting.createdAt).toLocaleString(locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}_`];
    if (meeting.summary.status === 'available') parts.push(`## ${labels.summary}\n\n${meeting.summary.text.trim()}`);
    if (meeting.notes.trim()) parts.push(`## ${labels.notes}\n\n${meeting.notes.trim()}`);
    if (meeting.segments.length) parts.push(`## ${labels.transcript}\n\n${transcriptText(meeting, labels)}`);
    return parts.join('\n\n');
};

/** Action items from a summary: checkbox lines anywhere, or bullets under an
 *  "Action items" / "Next steps" / "To-do" / "Follow-up" heading. */
const extractActionItems = (summary: string): string[] => {
    const items: string[] = [];
    let inActions = false;
    for (const raw of summary.split('\n')) {
        const line = raw.trim();
        const heading = /^(#{1,6}\s+|\*\*)(.+?)(\*\*)?:?$/.exec(line);
        if (heading && !/^[-*•]/.test(line)) { inActions = /action|next step|to-?do|follow[- ]?up|tasks?/i.test(heading[2]); continue; }
        const task = /^[-*•]\s+\[( |x|X)\]\s+(.+)$/.exec(line);
        const bullet = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line);
        const text = task ? (task[1] === ' ' ? task[2] : null) : inActions && bullet ? bullet[1] : null;
        if (text) items.push(text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 200));
    }
    return [...new Set(items.filter(Boolean))].slice(0, 15);
};

/** Mounted once by the application layout, independently of Home or chat views. */
export function MeetingWorkspace() {
    const { t, locale } = useI18n();
    const summaryBlocked = useEnterpriseMode();
    const capture = React.useSyncExternalStore(meetingCapture.subscribe, meetingCapture.getSnapshot);
    const [open, setOpen] = React.useState(false);
    const [supported, setSupported] = React.useState(meetingsSupported);
    const [meetings, setMeetings] = React.useState<Meeting[]>([]);
    const [selected, setSelected] = React.useState<Meeting | null>(null);
    const [readiness, setReadiness] = React.useState<MeetingReadiness | null>(null);
    const [systemSupported, setSystemSupported] = React.useState(false);
    const [seed, setSeed] = React.useState<z.infer<typeof meetingLaunchSchema>>({ title: '' });
    const [drafts, setDrafts] = React.useState(new Map<string, string>());
    const [tab, setTab] = React.useState<Tab>('notes');
    const [consent, setConsentState] = React.useState(storedConsent);
    const setConsent = React.useCallback((value: boolean) => { setConsentState(value); if (REMEMBER_CONSENT) writeFlag(CONSENT_KEY, value ? '1' : null); }, []);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState(false);
    const [summaryNotice, setSummaryNotice] = React.useState(false);
    const [partial, setPartial] = React.useState(false);
    const [choices, setChoices] = React.useState<SummaryChoices | null>(null);
    const [model, setModel] = React.useState('');
    const [approval, setApproval] = React.useState<SummaryApproval | null>(null);
    const [approved, setApproved] = React.useState(false);
    const [filter, setFilter] = React.useState('');
    const [saveState, setSaveState] = React.useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const [autoSummary, setAutoSummary] = React.useState<AutoSummary>(null);
    const [pillDismissed, setPillDismissed] = React.useState(false);
    const [errorDismissedFor, setErrorDismissedFor] = React.useState<string | null>(null);
    const [copied, setCopied] = React.useState<Tab | null>(null);
    const [titleDraft, setTitleDraft] = React.useState<{ id: string; value: string } | null>(null);
    const [taskState, setTaskState] = React.useState<{ id: string; state: 'adding' | 'added' | 'error'; count: number; message?: string } | null>(null);
    const [notionState, setNotionState] = React.useState<{ id: string; state: 'saving' | 'saved' | 'error'; message?: string } | null>(null);
    const generation = React.useRef(0);
    // Only a runtime switch invalidates a one-click start; list refreshes must not.
    const runtimeEpoch = React.useRef(0);
    const quickStartRef = React.useRef<(launch: z.infer<typeof meetingLaunchSchema>, mode?: 'system-and-microphone' | 'microphone') => Promise<void>>(async () => {});
    const summaryEpoch = React.useRef(0);
    const pending = React.useRef(false);
    const active = !['idle', 'error'].includes(capture.phase);
    const meeting = active && selected && capture.meeting?.id === selected.id ? capture.meeting : selected;
    const elapsed = useElapsed(capture.phase, capture.meeting?.id);

    const upsert = React.useCallback((result: Meeting) => {
        setSelected((current) => current?.id === result.id ? result : current);
        setMeetings((current) => current.some((item) => item.id === result.id) ? current.map((item) => item.id === result.id ? result : item) : [result, ...current]);
    }, []);

    React.useEffect(() => {
        const saved = capture.meeting;
        if (!saved) return;
        setSelected((current) => current?.id === saved.id && current.updatedAt <= saved.updatedAt ? saved : current);
        setMeetings((current) => current.map((item) => item.id === saved.id && item.updatedAt <= saved.updatedAt ? saved : item));
    }, [capture.meeting]);
    React.useEffect(() => { if (active || capture.error) setPillDismissed(false); }, [active, capture.error]);

    React.useEffect(() => {
        const launch = (event: Event) => {
            if (!(event instanceof CustomEvent)) return;
            const parsed = meetingLaunchSchema.safeParse(event.detail);
            if (!parsed.success) return;
            // An active recording is the place to go back to, not a new one.
            const snapshot = meetingCapture.getSnapshot();
            if (!['idle', 'error'].includes(snapshot.phase)) { setSelected(snapshot.meeting); setTab('transcript'); setOpen(true); return; }
            setSupported(meetingsSupported()); setSeed(parsed.data); setSelected(null); setOpen(true); setConsentState(storedConsent());
            if (parsed.data.autoStart) void quickStartRef.current(parsed.data);
        };
        window.addEventListener(MEETING_WORKSPACE_EVENT, launch);
        const unsubscribe = subscribeRuntimeEndpointChanged(() => {
            generation.current++; runtimeEpoch.current++; setOpen(false); setSelected(null); setMeetings([]); setDrafts(new Map()); setReadiness(null); setSupported(meetingsSupported()); setAutoSummary(null);
        });
        return () => { window.removeEventListener(MEETING_WORKSPACE_EVENT, launch); unsubscribe(); };
    }, []);
    const refresh = React.useCallback(async () => {
        const version = ++generation.current;
        setBusy(true); setError(false);
        try {
            const result = await listMeetings();
            if (version !== generation.current) return;
            setMeetings(result.meetings); setReadiness(result.readiness); setSystemSupported(result.capture.systemAudioSupported);
            setPartial(result.warnings.length > 0);
            setSelected((current) => current ? result.meetings.find((item) => item.id === current.id && item.updatedAt >= current.updatedAt) ?? current : null);
        } catch { if (version === generation.current) setError(true); }
        finally { if (version === generation.current) setBusy(false); }
    }, []);
    React.useEffect(() => { if (open && supported) void refresh(); }, [open, supported, refresh]);
    React.useEffect(() => { summaryEpoch.current++; setChoices(null); setModel(rememberedSummaryModel() ?? ''); setApproval(null); setApproved(false); setSummaryNotice(false); }, [selected?.id, open, summaryBlocked]);
    const run = async (operation: () => Promise<void>) => {
        if (pending.current) return;
        const version = generation.current;
        pending.current = true; setBusy(true); setError(false);
        try { await operation(); } catch { if (version === generation.current) setError(true); }
        finally { pending.current = false; if (version === generation.current) setBusy(false); }
    };
    const choose = (item: Meeting) => {
        const version = generation.current;
        void run(async () => {
            const result = await getMeeting(item.id);
            if (version === generation.current) { setSelected(result); setSummaryNotice(false); setTab(result.summary.status === 'available' ? 'summary' : result.segments.length ? 'transcript' : 'notes'); }
        });
    };
    const create = () => {
        const version = generation.current;
        void run(async () => {
            const result = await createMeeting(seed.title.trim() || defaultTitle(locale), seed.calendarEventId);
            if (version !== generation.current) return;
            setSelected(result); setMeetings((current) => [result, ...current]); setSeed({ title: '' }); setTab('notes');
        });
    };
    const begin = React.useCallback((target: Meeting, mode: 'system-and-microphone' | 'microphone') => {
        writeFlag(MODE_KEY, mode);
        setTab('transcript');
        void meetingCapture.start(target, mode);
    }, []);
    // One click: create the meeting and start recording. Anything that needs a
    // decision (first-time acknowledgement, missing model) falls back to the
    // workspace instead of guessing.
    const quickStart = React.useCallback(async (launch: z.infer<typeof meetingLaunchSchema>, mode: 'system-and-microphone' | 'microphone' = storedMode()) => {
        if (pending.current || !['idle', 'error'].includes(meetingCapture.getSnapshot().phase)) return;
        const epoch = runtimeEpoch.current;
        pending.current = true; setBusy(true); setError(false);
        try {
            if (!meetingsSupported() || !storedConsent()) return;
            if (!(await meetingReadiness()).available) return;
            const created = await createMeeting(launch.title.trim() || defaultTitle(locale), launch.calendarEventId);
            if (epoch !== runtimeEpoch.current) return;
            setSelected(created); setMeetings((current) => [created, ...current]); setSeed({ title: '' });
            begin(created, mode);
        } catch { if (epoch === runtimeEpoch.current) setError(true); }
        finally { pending.current = false; if (epoch === runtimeEpoch.current) setBusy(false); }
    }, [begin, locale]);
    React.useEffect(() => { quickStartRef.current = quickStart; }, [quickStart]);

    // Notes autosave (debounced), like a Notion page.
    const notes = selected ? drafts.get(selected.id) ?? selected.notes : '';
    const saveNotes = React.useCallback((id: string, value: string) => {
        setSaveState('saving');
        const version = generation.current;
        saveMeetingNotes(id, value).then((result) => {
            if (version !== generation.current) return;
            upsert(result);
            // Preserve edits made while saving; only the submitted draft is settled.
            setDrafts((current) => { if (current.get(id) !== value) return current; const next = new Map(current); next.delete(id); return next; });
            setSaveState('saved');
        }).catch(() => { if (version === generation.current) setSaveState('error'); });
    }, [upsert]);
    React.useEffect(() => {
        if (!selected) return;
        const draft = drafts.get(selected.id);
        if (draft === undefined || draft === selected.notes) return;
        const id = selected.id;
        const timer = setTimeout(() => saveNotes(id, draft), 700);
        return () => clearTimeout(timer);
    }, [drafts, selected, saveNotes]);

    // When a recording ends with the workspace open, reload the list so status
    // chips are current and any earlier list error clears.
    const lastPhase = React.useRef(capture.phase);
    React.useEffect(() => {
        const was = lastPhase.current;
        lastPhase.current = capture.phase;
        if (open && was !== capture.phase && (capture.phase === 'idle' || capture.phase === 'error') && was !== 'idle' && was !== 'error') void refresh();
    }, [capture.phase, open, refresh]);

    // Automatic summary once a recording stops (after the first reviewed one).
    const autoRan = React.useRef(new Set<string>());
    const previousPhase = React.useRef(capture.phase);
    React.useEffect(() => {
        const was = previousPhase.current;
        previousPhase.current = capture.phase;
        const finished = capture.meeting;
        if (!finished || capture.phase !== 'idle' || was === 'idle' || capture.error) return;
        if (summaryBlocked || !finished.segments.length || autoRan.current.has(finished.id)) return;
        const remembered = rememberedSummaryModel();
        if (!remembered) return;
        autoRan.current.add(finished.id);
        const epoch = runtimeEpoch.current;
        setAutoSummary({ id: finished.id, state: 'running' });
        void (async () => {
            try {
                const fresh = await getMeeting(finished.id);
                if (fresh.status !== 'stopped' && fresh.status !== 'interrupted') throw new Error('not_closed');
                const available = await listSummaryModels(finished.id);
                if (!available.available || !available.models.some((choice) => choice.model === remembered)) throw new Error('model_unavailable');
                const token = await prepareMeetingSummary(finished.id, remembered);
                const result = await generateMeetingSummary(finished.id, token);
                if (epoch !== runtimeEpoch.current) return;
                upsert(result);
                setAutoSummary({ id: finished.id, state: 'done' });
                setTab((current) => current === 'transcript' ? 'summary' : current);
            } catch {
                if (epoch === runtimeEpoch.current) setAutoSummary({ id: finished.id, state: 'failed' });
            }
        })();
    }, [capture.phase, capture.meeting, capture.error, summaryBlocked, upsert]);
    React.useEffect(() => {
        if (autoSummary?.state !== 'done' && autoSummary?.state !== 'failed') return;
        const timer = setTimeout(() => setAutoSummary(null), autoSummary.state === 'done' ? 9000 : 12000);
        return () => clearTimeout(timer);
    }, [autoSummary]);

    const captureError = `${capture.error === 'system' ? t('meeting.systemError') : capture.error === 'interrupted' ? t('meeting.interrupted') : t('meeting.captureError')}${capture.detail ? ` (${capture.detail})` : ''}`;
    const summaryClosed = meeting?.status === 'stopped' || meeting?.status === 'interrupted';
    const remembered = rememberedSummaryModel();
    const summaryAction = () => {
        if (!meeting || summaryBlocked || !summaryClosed) { setSummaryNotice(true); return; }
        const id = meeting.id;
        const version = generation.current;
        const epoch = summaryEpoch.current;
        const current = () => version === generation.current && epoch === summaryEpoch.current;
        void run(async () => {
            const savedModel = rememberedSummaryModel();
            // Remembered model + disclosure: one click straight through the token flow.
            if (savedModel && !approval) {
                const token = await prepareMeetingSummary(id, savedModel);
                const result = await generateMeetingSummary(id, token);
                if (current()) upsert(result);
                return;
            }
            if (!choices) {
                const result = await listSummaryModels(id);
                if (current()) { setChoices(result); setSummaryNotice(!result.available); if (!model && result.models.length === 1) setModel(result.models[0].model); }
                return;
            }
            if (!model) return;
            if (!approval) {
                const result = await prepareMeetingSummary(id, model);
                if (current()) { setApproval(result); setApproved(false); }
                return;
            }
            if (!approved) return;
            setApproval(null); setApproved(false);
            const result = await generateMeetingSummary(id, approval);
            writeFlag(SUMMARY_MODEL_KEY, approval.model); writeFlag(SUMMARY_ACK_KEY, approval.model);
            if (current()) upsert(result);
        });
    };
    const forgetSummaryModel = () => { writeFlag(SUMMARY_MODEL_KEY, null); writeFlag(SUMMARY_ACK_KEY, null); setModel(''); setChoices(null); setApproval(null); };

    const level = Math.max(capture.microphone, capture.system);
    const recordingHere = Boolean(active && meeting && capture.meeting?.id === meeting.id);
    const pauseResume = () => void (capture.phase === 'paused' ? meetingCapture.resume() : meetingCapture.pause());
    // Empty drafts (an abandoned start: no transcript, no notes) older than half an
    // hour are clutter; they stay on disk but drop out of the list.
    const staleDraft = (item: Meeting) => item.status === 'draft' && !item.segments.length && !item.notes.trim() && Date.now() - Date.parse(item.createdAt) > 30 * 60_000 && item.id !== meeting?.id;
    const visible = meetings.filter((item) => !staleDraft(item));
    const filtered = filter.trim() ? visible.filter((item) => item.title.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())) : visible;
    const statusChip = (item: Meeting) => {
        const live = active && capture.meeting?.id === item.id;
        const label = live ? (capture.phase === 'paused' ? t('meeting.paused') : t('meeting.recording')) : item.status === 'draft' ? t('meeting.ui.draft') : item.status === 'interrupted' ? t('meeting.ui.interrupted') : item.summary.status === 'available' ? t('meeting.ui.summarized') : t('meeting.ui.done');
        return <span className={cn('inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10.5px] font-medium',
            live ? 'bg-red-500/15 text-red-400' : item.summary.status === 'available' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-muted text-muted-foreground')}>
            {live ? <span className="oc-rec-dot size-1.5 rounded-full bg-red-500" /> : null}{label}
        </span>;
    };
    const tabKeys = (event: React.KeyboardEvent<HTMLButtonElement>) => {
        const index = tabs.indexOf(tab);
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault(); setTab(tabs[next]);
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    };
    const openWorkspace = (target: Meeting | null, focusTab?: Tab) => { setSelected(target); if (focusTab) setTab(focusTab); setOpen(true); };

    const ready = Boolean(readiness?.available);
    const startControls = (target: Meeting | null) => <div className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" className="oc-press gap-1.5 rounded-lg px-3.5" disabled={busy || !consent || !ready || (target ? target.status !== 'draft' : false) || !systemSupported}
                onClick={() => target ? begin(target, 'system-and-microphone') : void quickStart({ title: seed.title, calendarEventId: seed.calendarEventId }, 'system-and-microphone')}>
                <Icon name="mic" className="size-4" />{t('meeting.ui.startTranscribing')}
            </Button>
            <Button size="sm" variant="ghost" className="oc-press text-muted-foreground" disabled={busy || !consent || !ready || (target ? target.status !== 'draft' : false)}
                onClick={() => target ? begin(target, 'microphone') : void quickStart({ title: seed.title, calendarEventId: seed.calendarEventId }, 'microphone')}>
                {t('meeting.ui.micOnly')}
            </Button>
        </div>
        {!ready && readiness ? <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-[12px] text-muted-foreground">
            <Icon name="information" className="size-3.5" />{t('meeting.modelRequired')} {readiness.modelId}
            <Button size="xs" variant="outline" className="ml-auto" onClick={() => { setOpen(false); useUIStore.getState().setSettingsPage('voice'); useUIStore.getState().setSettingsDialogOpen(true); }}>{t('settings.page.voice.title')}</Button>
        </div> : null}
        {!consent ? <label className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] leading-snug text-foreground/85"><Checkbox checked={consent} onChange={setConsent} ariaLabel={t('meeting.consent')} /><span>{t('meeting.consent')}</span></label> : null}
        {!systemSupported && consent && ready ? <p className="text-[11.5px] text-muted-foreground">{t('meeting.screenPermission')}</p> : null}
    </div>;

    const pillClass = 'oc-meeting-pill app-region-no-drag fixed bottom-5 left-1/2 z-[55] flex -translate-x-1/2 items-center rounded-full border bg-[var(--surface-elevated,var(--background))] shadow-[0_12px_40px_-8px_rgba(0,0,0,0.55)]';
    const labels = () => ({ microphone: t('meeting.microphone'), system: t('meeting.system'), summary: t('meeting.summary'), notes: t('meeting.notes'), transcript: t('meeting.transcript') });
    const commitTitle = (target: Meeting) => {
        const draft = titleDraft?.id === target.id ? titleDraft.value.trim() : null;
        setTitleDraft(null);
        if (!draft || draft === target.title) return;
        const version = generation.current;
        upsert({ ...target, title: draft });
        renameMeeting(target.id, draft).then((result) => { if (version === generation.current) upsert(result); })
            .catch(() => { if (version === generation.current) { upsert(target); setError(true); } });
    };
    // Bring the meeting into a fresh chat on Home, ready to discuss.
    const discussInChat = (target: Meeting) => {
        const content = meetingMarkdown(target, locale, labels());
        setOpen(false);
        useSessionTabsStore.getState().cancelNewTab();
        useUIStore.getState().closeMainSurfaces();
        useSessionUIStore.getState().openNewSessionDraft({ initialPrompt: `${t('meeting.ui.chatIntro', { title: target.title })}\n\n<meeting title="${target.title.replace(/"/g, "'")}">\n${content}\n</meeting>\n\n` });
    };
    const sendToNotion = (target: Meeting) => {
        setNotionState({ id: target.id, state: 'saving' });
        exportMeetingToNotion(target.title, meetingMarkdown(target, locale, labels()))
            .then(() => setNotionState({ id: target.id, state: 'saved' }))
            .catch((cause: unknown) => setNotionState({ id: target.id, state: 'error', message: cause instanceof Error ? cause.message.replace(/^Error:\s*/, '') : String(cause) }));
    };

    const pill = (() => {
        if (open) return null;
        if (active) {
            return <div className={cn(pillClass, 'gap-1 border-border/80 py-1 pl-1.5 pr-1')}>
                <button type="button" onClick={() => openWorkspace(capture.meeting, 'transcript')} className="oc-press flex min-w-0 items-center gap-2 rounded-full px-2 py-1 hover:bg-interactive-hover" title={capture.meeting?.title}>
                    <span className={cn('size-2 shrink-0 rounded-full', capture.phase === 'paused' ? 'bg-amber-400' : 'oc-rec-dot bg-red-500')} />
                    <span className="font-mono text-[12.5px] tabular-nums text-foreground">{capture.phase === 'starting' ? '…' : clock(elapsed)}</span>
                    <Waveform level={level} live={capture.phase === 'recording'} className={capture.phase === 'paused' ? 'text-amber-400' : 'text-red-400'} />
                    {capture.meeting?.segments.length ? <span className="hidden max-w-[34ch] truncate text-[12px] text-muted-foreground md:inline">{capture.meeting.segments[capture.meeting.segments.length - 1].text}</span> : <span className="hidden text-[12px] text-muted-foreground md:inline">{capture.phase === 'starting' ? t('meeting.ui.starting') : t('meeting.ui.listening')}</span>}
                </button>
                <button type="button" aria-label={capture.phase === 'paused' ? t('meeting.resume') : t('meeting.pause')} title={capture.phase === 'paused' ? t('meeting.resume') : t('meeting.pause')} disabled={!['recording', 'paused'].includes(capture.phase)} onClick={pauseResume}
                    className="oc-press flex size-8 items-center justify-center rounded-full text-foreground hover:bg-interactive-hover disabled:opacity-40">
                    <Icon name={capture.phase === 'paused' ? 'play' : 'pause'} className="size-4" />
                </button>
                <button type="button" aria-label={t('meeting.stop')} title={t('meeting.stop')} disabled={capture.phase === 'stopping'} onClick={() => void meetingCapture.stop()}
                    className="oc-press flex h-8 items-center gap-1.5 rounded-full bg-red-500/90 px-3 text-[12px] font-medium text-white hover:bg-red-500 disabled:opacity-50">
                    <span className="size-2.5 rounded-[2px] bg-white" />{capture.phase === 'stopping' ? t('meeting.ui.stopping') : t('meeting.stop')}
                </button>
            </div>;
        }
        if (capture.error && !pillDismissed && !(capture.meeting?.status === 'stopped' && capture.meeting.segments.length)) {
            return <div role="alert" className={cn(pillClass, 'max-w-[min(640px,92vw)] gap-2 border-red-500/40 py-1.5 pl-3 pr-1.5')}>
                <Icon name="error-warning" className="size-4 shrink-0 text-red-400" />
                <span className="min-w-0 truncate text-[12px] text-foreground" title={captureError}>{captureError}</span>
                <Button size="xs" variant="ghost" onClick={() => openWorkspace(capture.meeting)}>{t('meeting.ui.open')}</Button>
                <button type="button" aria-label={t('meeting.ui.dismiss')} onClick={() => setPillDismissed(true)} className="oc-press flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-interactive-hover"><Icon name="close" className="size-3.5" /></button>
            </div>;
        }
        if (autoSummary) {
            const target = meetings.find((item) => item.id === autoSummary.id) ?? (capture.meeting?.id === autoSummary.id ? capture.meeting : null);
            return <div className={cn(pillClass, 'gap-2 border-border/80 py-1.5 pl-3 pr-1.5')}>
                <Icon name={autoSummary.state === 'running' ? 'loader-4' : autoSummary.state === 'done' ? 'sparkling' : 'error-warning'} className={cn('size-4', autoSummary.state === 'running' && 'animate-spin text-muted-foreground', autoSummary.state === 'done' && 'text-amber-300', autoSummary.state === 'failed' && 'text-red-400')} />
                <span className="text-[12.5px] text-foreground">{autoSummary.state === 'running' ? t('meeting.ui.summarizing') : autoSummary.state === 'done' ? t('meeting.ui.summaryReady') : t('meeting.ui.summaryFailed')}</span>
                <Button size="xs" variant="ghost" onClick={() => { if (autoSummary.state !== 'running') setAutoSummary(null); if (target) { setSelected(target); setTab('summary'); } setOpen(true); }}>{t('meeting.ui.open')}</Button>
            </div>;
        }
        return null;
    })();

    const summaryRunning = Boolean(meeting && autoSummary?.id === meeting.id && autoSummary.state === 'running');

    return <>
        {pill}
        <Dialog open={open} onOpenChange={setOpen}><DialogContent showCloseButton={false} className="flex h-[min(760px,86dvh)] w-[min(1080px,94vw)] max-w-none flex-row gap-0 overflow-hidden p-0 sm:max-w-none">
            <DialogTitle className="sr-only">{t('meeting.workspace')}</DialogTitle>
            <DialogDescription className="sr-only">{supported ? t('meeting.modelRequired') : t('meeting.unsupported')}</DialogDescription>
            {!supported ? <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
                <Icon name="mic" className="size-8 text-muted-foreground" />
                <p className="max-w-md text-sm text-muted-foreground">{t('meeting.unsupported')}</p>
                <Button size="sm" variant="outline" onClick={() => setOpen(false)}>{t('meeting.ui.close')}</Button>
            </div> : <>
                <aside className="hidden w-64 shrink-0 flex-col border-r border-border/60 bg-muted/[0.15] md:flex">
                    <div className="flex items-center gap-2 px-4 pb-2 pt-4">
                        <Icon name="mic" className="size-4 text-muted-foreground" />
                        <span className="text-[13px] font-semibold text-foreground">{t('meeting.ui.title')}</span>
                        <button type="button" title={t('home.refresh')} aria-label={t('home.refresh')} disabled={busy} onClick={() => void refresh()} className="oc-press ml-auto flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground"><Icon name="refresh" className={cn('size-3.5', busy && 'animate-spin')} /></button>
                    </div>
                    <div className="px-3 pb-2">
                        <button type="button" disabled={busy} onClick={() => { setSelected(null); setSeed({ title: '' }); }} className="oc-press flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-foreground hover:bg-interactive-hover">
                            <Icon name="add" className="size-4 text-muted-foreground" />{t('meeting.ui.new')}
                        </button>
                        <div className="mt-1.5 flex items-center gap-1.5 rounded-lg bg-background/60 px-2.5 py-1 ring-1 ring-border/60 focus-within:ring-primary/60">
                            <Icon name="search" className="size-3.5 text-muted-foreground" />
                            <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t('meeting.ui.filter')} aria-label={t('meeting.ui.filter')} className="min-w-0 flex-1 bg-transparent py-0.5 text-[12.5px] outline-none placeholder:text-muted-foreground/70" />
                        </div>
                    </div>
                    <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3" role="listbox" aria-label={t('meeting.workspace')}>
                        {error ? <button type="button" role="alert" onClick={() => void refresh()} className="block w-full rounded-md px-2 py-1 text-left text-[12px] text-destructive hover:bg-interactive-hover">{t('personalTools.error')} <span className="underline">{t('home.refresh')}</span></button> : null}
                        {partial ? <p role="status" className="px-2 py-1 text-[12px] text-[var(--status-warning-text)]">{t('meeting.partial')}</p> : null}
                        {!filtered.length && !busy ? <p className="px-2 py-4 text-center text-[12px] text-muted-foreground">{t('meeting.ui.none')}</p> : null}
                        {filtered.map((item) => <button key={item.id} type="button" role="option" aria-selected={meeting?.id === item.id} disabled={busy && meeting?.id !== item.id} onClick={() => choose(item)}
                            className={cn('oc-press block w-full rounded-lg px-2.5 py-1.5 text-left', meeting?.id === item.id ? 'bg-interactive-selection' : 'hover:bg-interactive-hover')}>
                            <span className="block truncate text-[13px] font-medium text-foreground">{item.title}</span>
                            <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">{new Date(item.createdAt).toLocaleDateString(locale, { month: 'short', day: 'numeric' })} · {new Date(item.createdAt).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })} {statusChip(item)}</span>
                        </button>)}
                    </div>
                </aside>
                <main className="relative flex min-w-0 flex-1 flex-col">
                    <button type="button" aria-label={t('meeting.ui.close')} onClick={() => setOpen(false)} className="oc-press absolute right-3 top-3 z-10 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground"><Icon name="close" className="size-4" /></button>
                    {!meeting ? <div key="empty" className="oc-fade-in flex flex-1 flex-col justify-center overflow-y-auto px-10 py-8 md:px-16">
                        <div className="mb-5 flex size-12 items-center justify-center rounded-2xl bg-red-500/10 text-red-400"><Icon name="mic" className="size-6" /></div>
                        <h2 className="text-[26px] font-bold tracking-tight text-foreground">{t('meeting.ui.emptyTitle')}</h2>
                        <p className="mt-1.5 max-w-lg text-[13.5px] leading-relaxed text-muted-foreground">{t('meeting.ui.emptyBody')}</p>
                        <div className="mt-6 max-w-lg space-y-3">
                            <Input autoFocus aria-label={t('home.eventTitle')} placeholder={defaultTitle(locale)} value={seed.title} maxLength={240} onChange={(event) => setSeed({ ...seed, title: event.target.value })}
                                onKeyDown={(event) => { if (event.key === 'Enter' && consent && ready) { event.preventDefault(); void quickStart({ title: seed.title, calendarEventId: seed.calendarEventId }); } }} />
                            {startControls(null)}
                            <button type="button" disabled={busy} onClick={create} className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">{t('meeting.ui.createOnly')}</button>
                        </div>
                    </div> : <div key={meeting.id} className="oc-fade-in flex min-h-0 flex-1 flex-col">
                        <header className="px-10 pb-3 pt-9 md:px-14">
                            <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
                                <Icon name="calendar" className="size-3.5" />
                                <time dateTime={meeting.createdAt}>{new Date(meeting.createdAt).toLocaleString(locale, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
                                {statusChip(meeting)}
                                {recordingHere ? <span className="font-mono tabular-nums">{clock(elapsed)}</span> : null}
                            </div>
                            <input aria-label={t('meeting.ui.rename')} title={t('meeting.ui.rename')} value={titleDraft?.id === meeting.id ? titleDraft.value : meeting.title} maxLength={300}
                                onChange={(event) => setTitleDraft({ id: meeting.id, value: event.target.value })}
                                onBlur={() => commitTitle(meeting)}
                                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setTitleDraft(null); event.currentTarget.blur(); } }}
                                className="-mx-1.5 mt-1 w-[calc(100%-2rem)] rounded-md bg-transparent px-1.5 py-0.5 text-[26px] font-bold leading-tight tracking-tight text-foreground outline-none transition-colors hover:bg-interactive-hover/60 focus:bg-interactive-hover/60" />
                            {meeting.status !== 'draft' && !recordingHere ? <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                                <Button size="sm" variant="outline" className="oc-press h-7 gap-1.5 rounded-full px-3 text-[12px]" disabled={!meeting.segments.length && !meeting.notes.trim()} onClick={() => discussInChat(meeting)}>
                                    <Icon name="chat-new" className="size-3.5" />{t('meeting.ui.discuss')}
                                </Button>
                                <Button size="sm" variant="ghost" className="oc-press h-7 gap-1.5 rounded-full px-3 text-[12px] text-muted-foreground hover:text-foreground" disabled={notionState?.id === meeting.id && notionState.state === 'saving'} onClick={() => sendToNotion(meeting)}>
                                    <Icon name={notionState?.id === meeting.id && notionState.state === 'saved' ? 'check' : notionState?.id === meeting.id && notionState.state === 'saving' ? 'loader-4' : 'upload-2'} className={cn('size-3.5', notionState?.id === meeting.id && notionState.state === 'saving' && 'animate-spin')} />
                                    {notionState?.id === meeting.id && notionState.state === 'saved' ? t('meeting.ui.notionSaved') : t('meeting.ui.notion')}
                                </Button>
                                {notionState?.id === meeting.id && notionState.state === 'error' ? <span role="alert" className="text-[11.5px] text-destructive">{notionState.message || t('personalTools.error')}</span> : null}
                            </div> : null}
                            {recordingHere ? <div className="mt-4 flex flex-wrap items-center gap-2">
                                <span className="flex items-center gap-2 rounded-full bg-red-500/10 px-3 py-1.5 text-red-400"><Waveform level={level} live={capture.phase === 'recording'} /><span className="text-[12px] font-medium">{capture.phase === 'paused' ? t('meeting.paused') : capture.phase === 'recording' ? t('meeting.ui.listening') : t('meeting.ui.starting')}</span></span>
                                <Button size="sm" variant="outline" className="oc-press gap-1.5 rounded-full" disabled={!['recording', 'paused'].includes(capture.phase)} onClick={pauseResume}><Icon name={capture.phase === 'paused' ? 'play' : 'pause'} className="size-3.5" />{capture.phase === 'paused' ? t('meeting.resume') : t('meeting.pause')}</Button>
                                <Button size="sm" className="oc-press gap-1.5 rounded-full bg-red-500 text-white hover:bg-red-500/90" disabled={capture.phase === 'stopping'} onClick={() => void meetingCapture.stop()}><span className="size-2 rounded-[2px] bg-white" />{t('meeting.stop')}</Button>
                                {(capture.silentMicrophone || capture.silentSystem) ? <p role="status" className="w-full text-[11.5px] text-[var(--status-warning-text)]">{t('meeting.silence')}</p> : null}
                            </div> : meeting.status === 'draft' && !active ? <div className="mt-4">{startControls(meeting)}</div> : null}
                            {capture.error && capture.meeting?.id === meeting.id && errorDismissedFor !== meeting.id && !(meeting.status === 'stopped' && meeting.segments.length) ? <div className="relative mt-3 space-y-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 pr-9">
                                <button type="button" aria-label={t('meeting.ui.dismiss')} onClick={() => setErrorDismissedFor(meeting.id)} className="oc-press absolute right-2 top-2 flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"><Icon name="close" className="size-3.5" /></button>
                                <p role="alert" className="text-[12px] text-red-400">{captureError}</p>
                                {!active && !meeting.segments.length ? <div className="flex flex-wrap gap-2">
                                    <Button size="xs" disabled={busy} onClick={() => void quickStart({ title: meeting.title }, 'system-and-microphone')}>{t('meeting.ui.startTranscribing')}</Button>
                                    <Button size="xs" variant="outline" disabled={busy} onClick={() => void quickStart({ title: meeting.title }, 'microphone')}>{t('meeting.ui.micOnly')}</Button>
                                </div> : null}
                            </div> : null}
                        </header>
                        <div role="tablist" aria-label={t('meeting.workspace')} className="flex gap-1 border-b border-border/60 px-10 md:px-14">
                            {tabs.map((value) => <button key={value} type="button" id={`meeting-tab-${value}`} role="tab" aria-selected={tab === value} aria-controls={`meeting-panel-${value}`} tabIndex={tab === value ? 0 : -1} onKeyDown={tabKeys} onClick={() => setTab(value)}
                                className={cn('relative -mb-px flex items-center gap-1.5 px-2.5 pb-2 pt-1 text-[13px] transition-colors', tab === value ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                                <Icon name={value === 'summary' ? 'sparkling' : value === 'notes' ? 'edit' : 'text'} className="size-3.5" />
                                {t(value === 'notes' ? 'meeting.notes' : value === 'transcript' ? 'meeting.transcript' : 'meeting.summary')}
                                {value === 'transcript' && meeting.segments.length ? <span className="text-[10.5px] text-muted-foreground">{meeting.segments.length}</span> : null}
                                {value === 'summary' && summaryRunning ? <Icon name="loader-4" className="size-3 animate-spin text-muted-foreground" /> : null}
                                <span className={cn('absolute inset-x-1 bottom-0 h-[2px] rounded-full bg-foreground transition-transform duration-200', tab === value ? 'scale-x-100' : 'scale-x-0')} />
                            </button>)}
                            {(tab === 'transcript' && meeting.segments.length) || (tab === 'summary' && meeting.summary.status === 'available') ? <button type="button"
                                onClick={() => {
                                    const text = tab === 'summary' && meeting.summary.status === 'available' ? meeting.summary.text
                                        : transcriptText(meeting, { microphone: t('meeting.microphone'), system: t('meeting.system') });
                                    void copyTextToClipboard(text).then(() => { setCopied(tab); setTimeout(() => setCopied(null), 1600); });
                                }}
                                className="oc-press ml-auto mb-1 flex items-center gap-1 self-center rounded-md px-2 py-1 text-[11.5px] text-muted-foreground hover:bg-interactive-hover hover:text-foreground">
                                <Icon name={copied === tab ? 'check' : 'file-copy'} className="size-3.5" />{copied === tab ? t('meeting.ui.copied') : t('meeting.ui.copy')}
                            </button> : null}
                            {tab === 'notes' ? <span className="ml-auto self-center pb-1 text-[11px] text-muted-foreground">{saveState === 'saving' ? t('meeting.ui.saving') : saveState === 'saved' ? t('meeting.ui.saved') : saveState === 'error' ? <span className="text-destructive">{t('meeting.ui.saveFailed')}</span> : null}</span> : null}
                        </div>
                        <div role="tabpanel" id={`meeting-panel-${tab}`} aria-labelledby={`meeting-tab-${tab}`} tabIndex={0} className="min-h-0 flex-1 overflow-y-auto px-10 py-5 md:px-14">
                            {tab === 'notes' ? <textarea aria-label={t('meeting.notes')} placeholder={t('meeting.ui.notesPlaceholder')} maxLength={100000} value={notes}
                                onChange={(event) => { const next = new Map(drafts); next.set(meeting.id, event.target.value); setDrafts(next); setSaveState('idle'); }}
                                onBlur={() => { const draft = drafts.get(meeting.id); if (draft !== undefined && draft !== meeting.notes) saveNotes(meeting.id, draft); }}
                                className="h-full min-h-[280px] w-full resize-none bg-transparent text-[14px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/60" /> : null}
                            {tab === 'transcript' ? (meeting.segments.length || recordingHere
                                ? <MeetingTranscript segments={meeting.segments} live={recordingHere} labels={{ microphone: t('meeting.microphone'), system: t('meeting.system'), listening: t('meeting.recording') }} />
                                : <p className="py-10 text-center text-[13px] text-muted-foreground">{t('meeting.ui.noTranscript')}</p>) : null}
                            {tab === 'summary' ? <div className="space-y-4">
                                {summaryRunning ? <div className="space-y-2.5"><p className="flex items-center gap-2 text-[12.5px] text-muted-foreground"><Icon name="sparkling" className="size-3.5 text-amber-300" />{t('meeting.ui.summarizing')}</p>{[92, 78, 85, 60, 70].map((width, index) => <div key={index} className="oc-shimmer h-3 rounded" style={{ width: `${width}%` }} />)}</div> : null}
                                {meeting.summary.status === 'available' ? <>
                                    <SummaryText text={meeting.summary.text} />
                                    {extractActionItems(meeting.summary.text).length ? (() => {
                                        const items = extractActionItems(meeting.summary.status === 'available' ? meeting.summary.text : '');
                                        const mine = taskState?.id === meeting.id ? taskState : null;
                                        return <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                                            <Icon name="list-check-2" className="size-4 text-muted-foreground" />
                                            <span className="text-[12.5px] text-foreground/85">{t('meeting.ui.actionItems', { count: items.length })}</span>
                                            <Button size="sm" variant="outline" className="oc-press ml-auto h-7 gap-1.5 rounded-full px-3 text-[12px]" disabled={mine?.state === 'adding' || mine?.state === 'added'}
                                                onClick={() => {
                                                    setTaskState({ id: meeting.id, state: 'adding', count: 0 });
                                                    void (async () => {
                                                        let added = 0;
                                                        try {
                                                            for (const item of items) { await createHomeTask(item); added += 1; setTaskState({ id: meeting.id, state: 'adding', count: added }); }
                                                            setTaskState({ id: meeting.id, state: 'added', count: added });
                                                            window.dispatchEvent(new CustomEvent('open-carter:tasks-changed'));
                                                        } catch (cause) {
                                                            setTaskState({ id: meeting.id, state: 'error', count: added, message: cause instanceof Error ? cause.message.replace(/^Error:\s*/, '') : String(cause) });
                                                        }
                                                    })();
                                                }}>
                                                <Icon name={mine?.state === 'added' ? 'check' : mine?.state === 'adding' ? 'loader-4' : 'add'} className={cn('size-3.5', mine?.state === 'adding' && 'animate-spin')} />
                                                {mine?.state === 'added' ? t('meeting.ui.tasksAdded', { count: mine.count }) : mine?.state === 'adding' ? `${mine.count}/${items.length}` : t('meeting.ui.addTasks')}
                                            </Button>
                                            {mine?.state === 'error' ? <p role="alert" className="w-full text-[11.5px] text-destructive">{mine.message || t('personalTools.error')}</p> : null}
                                        </div>;
                                    })() : null}
                                    <p className="border-t border-border/50 pt-3 text-[11px] text-muted-foreground">{meeting.summary.providerID}/{meeting.summary.modelID} · {new Date(meeting.summary.createdAt).toLocaleString(locale)}</p>
                                </> : !summaryRunning ? <div className="rounded-xl border border-dashed border-border/80 p-5">
                                    <p className="flex items-center gap-2 text-[13.5px] font-medium text-foreground"><Icon name="sparkling" className="size-4 text-amber-300" />{t('meeting.ui.summaryTitle')}</p>
                                    <p className="mt-1 text-[12.5px] text-muted-foreground">{summaryBlocked ? t('home.blocked') : !summaryClosed ? t('meeting.ui.summaryAfterStop') : remembered ? t('meeting.ui.summaryAuto', { model: remembered }) : t('meeting.ui.summaryFirst')}</p>
                                    {summaryNotice && (!choices || !choices.available) ? <p role="status" className="mt-2 text-[12px] text-muted-foreground">{t('meeting.unavailable')}</p> : null}
                                    {choices?.available && !summaryBlocked && summaryClosed && !remembered ? <div className="mt-3 space-y-2">
                                        <Select value={model} disabled={busy} onValueChange={(value) => { summaryEpoch.current++; setModel(value); setApproval(null); setApproved(false); }}><SelectTrigger aria-label={t('meeting.summaryReview')}><SelectValue placeholder={t('meeting.ui.chooseModel')} /></SelectTrigger><SelectContent>{choices.models.map((choice) => <SelectItem key={choice.model} value={choice.model}>{choice.providerID}/{choice.modelID} · {choice.name}</SelectItem>)}</SelectContent></Select>
                                        {approval ? <label className="flex items-start gap-2 text-[12px]"><Checkbox checked={approved} onChange={setApproved} ariaLabel={t('meeting.summaryDisclosure', { provider: approval.providerID, model: approval.modelID })} /><span>{t('meeting.summaryDisclosure', { provider: approval.providerID, model: approval.modelID })} {t('meeting.ui.rememberNote')}</span></label> : null}
                                    </div> : null}
                                    <div className="mt-3 flex flex-wrap items-center gap-2">
                                        <Button size="sm" className="oc-press gap-1.5" disabled={busy || summaryBlocked || !summaryClosed || (!remembered && choices !== null && (!choices.available || !model)) || (approval !== null && !approved)} onClick={summaryAction}>
                                            {busy ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : <Icon name="sparkling" className="size-3.5" />}
                                            {remembered || approval || !choices ? t('meeting.generate') : t('meeting.summaryReview')}
                                        </Button>
                                        {remembered ? <button type="button" onClick={forgetSummaryModel} className="text-[11.5px] text-muted-foreground hover:text-foreground hover:underline">{t('meeting.ui.changeModel')}</button> : null}
                                    </div>
                                </div> : null}
                            </div> : null}
                        </div>
                    </div>}
                </main>
            </>}
        </DialogContent></Dialog>
    </>;
}

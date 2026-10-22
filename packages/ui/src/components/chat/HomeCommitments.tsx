import React from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { formatDirectoryName } from '@/lib/utils';
import {
  addCommitment, checkCommitmentNow, dueLabel, readCommitments, removeCommitment, saveCommitmentSettings, updateCommitment,
  type Commitment, type CommitmentList,
} from '@/lib/commitments';

const DAY_MS = 86_400_000;
const localDate = (value: number) => {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
/** A date picked in the form means the end of that day in the viewer's zone. */
const endOfLocalDay = (value: string) => {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 0, 0).getTime();
};

export const HomeCommitments: React.FC = () => {
  const { t, locale } = useI18n();
  const projects = useProjectsStore((state) => state.projects);
  const [data, setData] = React.useState<CommitmentList | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [title, setTitle] = React.useState('');
  const [date, setDate] = React.useState('');
  const [watch, setWatch] = React.useState('');
  const [research, setResearch] = React.useState(true);
  const generation = React.useRef(0);

  const load = React.useCallback(async () => {
    const run = ++generation.current;
    try {
      const next = await readCommitments();
      if (run === generation.current) { setData(next); setFailed(false); }
    } catch {
      if (run === generation.current) setFailed(true);
    }
  }, []);

  React.useEffect(() => {
    void load();
    const stopEvents = subscribeOpenchamberEvents((event) => { if (event.type === 'commitments-changed' || event.type === 'event-stream-ready') void load(); });
    const stopRuntime = subscribeRuntimeEndpointChanged(() => { setData(null); void load(); });
    return () => { stopEvents(); stopRuntime(); };
  }, [load]);

  // Runs one change, then re-reads so the card shows what the server holds.
  const act = async (work: () => Promise<void>) => {
    const runtime = getRuntimeKey();
    setBusy(true);
    try { await work(); } catch { toast.error(t('commitments.saveFailed')); }
    finally {
      setBusy(false);
      if (runtime === getRuntimeKey()) await load();
    }
  };

  const check = async (id: string) => {
    const outcome = await checkCommitmentNow(id);
    const key = { started: 'commitments.checkStarted', busy: 'commitments.checkBusy', excluded: 'commitments.checkExcluded', failed: 'commitments.checkFailed' } as const;
    (outcome === 'started' ? toast.success : toast.error)(t(key[outcome]));
  };

  const submit = () => {
    const cleanTitle = title.trim();
    const cleanWatch = watch.trim();
    if (!cleanTitle || (!date && !cleanWatch)) return;
    void act(async () => {
      await addCommitment({ title: cleanTitle, dueAt: date ? endOfLocalDay(date) : null, watches: cleanWatch ? [cleanWatch] : [], research });
      setTitle(''); setDate(''); setWatch(''); setResearch(true); setAdding(false);
    });
  };

  const items = (data?.items ?? []).filter((item) => item.status === 'active' || item.status === 'snoozed')
    .sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
  const settings = data?.settings;
  const formatDate = (value: number) => new Date(value).toLocaleDateString(locale, { month: 'short', day: 'numeric' });

  const row = (item: Commitment) => {
    const label = dueLabel(item.dueAt);
    const overdue = item.dueAt !== null && item.dueAt < Date.now() - DAY_MS / 2 && label.key.startsWith('commitments.due.overdue');
    const unconfirmed = item.origin === 'auto' && !item.confirmedAt;
    return (
      <div key={item.id} className="oc-home-row flex-col items-stretch gap-1 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="timer" className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{item.title}</span>
          <span className={overdue ? 'shrink-0 text-xs text-destructive' : 'shrink-0 text-xs text-muted-foreground'}>
            {t(label.key, 'count' in label ? { count: label.count } : undefined)}
          </span>
        </div>
        {item.status === 'snoozed' && item.snoozedUntil ? <p className="pl-5 text-xs text-muted-foreground">{t('commitments.snoozedUntil', { date: formatDate(item.snoozedUntil) })}</p> : null}
        {item.watches.length ? <p className="truncate pl-5 text-xs text-muted-foreground">{t('commitments.watching', { watch: item.watches.join(', ') })}</p> : null}
        {item.finding ? <p className="pl-5 text-xs text-muted-foreground">{t('commitments.lastFinding', { text: item.finding })}</p> : null}
        {!item.research ? <p className="pl-5 text-xs text-muted-foreground">{t('commitments.private')}</p> : null}
        {unconfirmed ? <p className="pl-5 text-xs text-muted-foreground">{t('commitments.autoAdded')}</p> : null}
        <div className="flex items-center gap-0.5 pl-4">
          {unconfirmed ? <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void act(() => updateCommitment(item.id, { confirmed: true }))}>{t('commitments.keep')}</Button> : null}
          <Button type="button" variant="ghost" size="icon" className="size-7" disabled={busy} aria-label={t('commitments.done')} title={t('commitments.done')} onClick={() => void act(() => updateCommitment(item.id, { status: 'done' }))}><Icon name="check" className="size-3.5" /></Button>
          <Button type="button" variant="ghost" size="icon" className="size-7" disabled={busy} aria-label={t('commitments.snooze')} title={t('commitments.snooze')} onClick={() => void act(() => updateCommitment(item.id, { status: 'snoozed', snoozedUntil: Date.now() + DAY_MS }))}><Icon name="pause" className="size-3.5" /></Button>
          <Button type="button" variant="ghost" size="icon" className="size-7" disabled={busy} aria-label={t('commitments.checkNow')} title={t('commitments.checkNow')} onClick={() => void act(() => check(item.id))}><Icon name="refresh" className="size-3.5" /></Button>
          <Button type="button" variant="ghost" size="icon" className="size-7" disabled={busy} aria-label={t('commitments.remove')} title={t('commitments.remove')} onClick={() => void act(() => removeCommitment(item.id))}><Icon name="delete-bin" className="size-3.5" /></Button>
        </div>
      </div>
    );
  };

  const patchSettings = (patch: Parameters<typeof saveCommitmentSettings>[0]) => void act(() => saveCommitmentSettings(patch));
  const excluded = new Set(settings?.excludedDirectories ?? []);

  return (
    <section>
      <h2 className="oc-home-card-heading">
        <Icon name="timer" className="size-3.5" />
        {t('commitments.title')}
        <span className="ml-auto flex items-center gap-0.5">
          <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={t('commitments.add')} title={t('commitments.add')} onClick={() => setAdding((open) => !open)}><Icon name="add" className="size-3.5" /></Button>
          <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={t('commitments.settings')} title={t('commitments.settings')} onClick={() => setSettingsOpen(true)}><Icon name="settings-3" className="size-3.5" /></Button>
        </span>
      </h2>
      {failed ? <p role="alert" className="oc-home-empty text-destructive">{t('commitments.loadFailed')}</p> : null}
      {adding ? (
        <form className="space-y-2 py-2" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <label className="block space-y-1 text-xs">{t('commitments.titleLabel')}<Input autoFocus value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} /></label>
          <label className="block space-y-1 text-xs">{t('commitments.dateLabel')}<Input type="date" value={date} min={localDate(Date.now())} onChange={(event) => setDate(event.target.value)} /></label>
          <label className="block space-y-1 text-xs">{t('commitments.watchLabel')}<Input value={watch} maxLength={200} onChange={(event) => setWatch(event.target.value)} /></label>
          <label className="flex items-center gap-2 text-xs"><Checkbox checked={research} ariaLabel={t('commitments.researchLabel')} onChange={setResearch} />{t('commitments.researchLabel')}</label>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !title.trim() || (!date && !watch.trim())}>{t('commitments.save')}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>{t('commitments.cancel')}</Button>
          </div>
        </form>
      ) : null}
      {items.map(row)}
      {data && !items.length && !failed ? <p className="oc-home-empty">{t('commitments.empty')}</p> : null}
      {!data && !failed ? <p className="oc-home-empty">{t('common.loading')}</p> : null}

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('commitments.settings.title')}</DialogTitle>
            <DialogDescription>{t('commitments.settings.foldersHint')}</DialogDescription>
          </DialogHeader>
          {settings ? (
            <div className="space-y-3 text-sm">
              <label className="flex items-center gap-2"><Checkbox checked={settings.enabled} ariaLabel={t('commitments.settings.enabled')} onChange={(enabled) => patchSettings({ enabled })} />{t('commitments.settings.enabled')}</label>
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1 text-xs">{t('commitments.settings.quietStart')}<Input type="time" defaultValue={settings.quietStart} onBlur={(event) => event.target.value && event.target.value !== settings.quietStart && patchSettings({ quietStart: event.target.value })} /></label>
                <label className="space-y-1 text-xs">{t('commitments.settings.quietEnd')}<Input type="time" defaultValue={settings.quietEnd} onBlur={(event) => event.target.value && event.target.value !== settings.quietEnd && patchSettings({ quietEnd: event.target.value })} /></label>
              </div>
              <div className="space-y-1 text-xs">
                <span>{t('commitments.settings.limit')}</span>
                <Select value={String(settings.dailyNudgeLimit)} onValueChange={(value) => patchSettings({ dailyNudgeLimit: Number(value) })}>
                  <SelectTrigger aria-label={t('commitments.settings.limit')}><SelectValue /></SelectTrigger>
                  <SelectContent>{[1, 2, 3, 4, 5].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1 text-xs">
                <span>{t('commitments.settings.folders')}</span>
                {projects.length ? projects.map((project) => (
                  <label key={project.id} className="flex min-w-0 items-center gap-2 py-0.5">
                    <Checkbox checked={excluded.has(project.path)} ariaLabel={project.label || formatDirectoryName(project.path)}
                      onChange={(on) => patchSettings({ excludedDirectories: on ? [...excluded, project.path] : [...excluded].filter((path) => path !== project.path) })} />
                    <span className="truncate">{project.label || formatDirectoryName(project.path)}</span>
                  </label>
                )) : <p className="text-muted-foreground">{t('commitments.settings.noFolders')}</p>}
              </div>
            </div>
          ) : <p className="oc-home-empty">{t('common.loading')}</p>}
        </DialogContent>
      </Dialog>
    </section>
  );
};

import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { personalHomeSupported, readHomeChatGPTTasks, type HomeChatGPTTaskFeed } from '@/lib/personal-home';

// Carter's ChatGPT/Codex automations, mirrored from ~/.codex/automations.
// This card is read-only. It has no run, pause or delete control because
// Open Carter owns none of these jobs: the file is the only thing it can read,
// and an external row never becomes a local schedule. There is also no row
// link, because no ChatGPT thread URL scheme has been verified.

const statusLabel = (status: string, t: ReturnType<typeof useI18n>['t']) =>
  status === 'ACTIVE' ? t('home.chatgpt.active') : status === 'PAUSED' ? t('home.chatgpt.paused') : t('home.chatgpt.status', { status });

export const HomeChatGPTTasks: React.FC = () => {
    const { t, locale } = useI18n();
    const [result, setResult] = React.useState<HomeChatGPTTaskFeed | null>(null);
    const [error, setError] = React.useState('');
    const [loading, setLoading] = React.useState(false);
    const pending = React.useRef(false);
    const generation = React.useRef(0);
    const supported = personalHomeSupported();

    const refresh = React.useCallback(async () => {
        if (pending.current) return;
        pending.current = true;
        const version = ++generation.current;
        setLoading(true);
        try {
            const next = await readHomeChatGPTTasks();
            if (version !== generation.current) return;
            // A read that reports its own failure keeps the last good snapshot
            // beside the error. It is never an authoritative empty list.
            if (next.error) { setError(next.error); return; }
            setResult(next);
            setError('');
        } catch (failure) {
            if (version !== generation.current) return;
            setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
            if (version === generation.current) setLoading(false);
            pending.current = false;
        }
    }, []);

    React.useEffect(() => {
        if (!supported) return;
        void refresh();
        const onFocus = () => { if (document.visibilityState !== 'hidden') void refresh(); };
        document.addEventListener('visibilitychange', onFocus);
        return () => { generation.current += 1; document.removeEventListener('visibilitychange', onFocus); };
    }, [supported, refresh]);

    if (!supported) return null;
    const rows = result?.rows ?? [];
    const time = (value: number) => new Date(value).toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return <section className="oc-home-card oc-home-chatgpt">
        <div className="oc-home-card-heading">
            <Icon name="timer" className="size-3.5" />
            {t('home.chatgpt.title')}
            <span className="oc-home-count ml-auto">{rows.length}</span>
            <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={t('home.refresh')} title={t('home.refresh')} disabled={loading} onClick={() => void refresh()}>
                <Icon name="refresh" className="size-3.5" />
            </Button>
        </div>
        <p className="oc-home-empty text-[11px]">{t('home.chatgpt.readOnly')}</p>
        {error && <p role="alert" className="oc-home-empty text-destructive">{t('home.chatgpt.unavailable')} {error}</p>}
        {result?.partial && <p role="status" className="oc-home-empty">
            {result.skipped.length === 1 ? t('home.chatgpt.partialOne') : t('home.chatgpt.partialMany', { count: result.skipped.length })}
        </p>}
        {!result && !error && <p role="status" className="oc-home-empty">{t('common.loading')}</p>}
        {result && !rows.length && <p className="oc-home-empty">{t('home.chatgpt.empty')}</p>}
        {rows.map((row) => <div key={row.providerJobId} className="oc-home-chatgpt-row">
            <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{row.name}</span>
                <span className={cn('shrink-0 rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] font-medium', row.status === 'ACTIVE' ? 'text-foreground' : 'text-muted-foreground')}>
                    {statusLabel(row.status, t)}
                </span>
            </div>
            <span className="oc-home-chatgpt-detail">
                {row.schedule.understood ? row.schedule.summary : t('home.chatgpt.scheduleUnknown')}
                {row.schedule.understood && <>
                    {' · '}
                    {row.schedule.nextRunAt === null
                        ? t('home.chatgpt.nextRunUnknown')
                        : row.schedule.timeZone
                            ? t('home.chatgpt.nextRunAtTime', { time: time(row.schedule.nextRunAt), zone: row.schedule.timeZone })
                            : t('home.chatgpt.nextRun', { time: time(row.schedule.nextRunAt) })}
                </>}
            </span>
            <span className="oc-home-chatgpt-detail" dir="ltr">{t('home.chatgpt.thread', { id: row.providerThreadId })}</span>
            <span className="oc-home-chatgpt-detail" dir="ltr">{t('home.chatgpt.jobId', { id: row.providerJobId })}</span>
        </div>)}
        {result && <p className="oc-home-empty text-[11px]">{t('home.chatgpt.readAt', { time: time(result.readAt) })}</p>}
    </section>;
};
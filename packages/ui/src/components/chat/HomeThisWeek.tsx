import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { completeHomeReminder, personalHomeSupported, readHomeReminders, saveHomeReminder, type HomeReminder } from '@/lib/personal-home';

const dayLabel = (due: string, overdue: boolean): string => {
    if (overdue) return 'Overdue';
    const date = new Date(due);
    if (Number.isNaN(date.getTime())) return '';
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const dueDay = new Date(date);
    dueDay.setHours(0, 0, 0, 0);
    const days = Math.round((dueDay.getTime() - start.getTime()) / 86_400_000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    return date.toLocaleDateString(undefined, { weekday: 'short' });
};

/** This week's reminders. Checking a row completes it in Reminders. */
export function HomeThisWeek(): React.ReactNode {
    const supported = personalHomeSupported();
    const [items, setItems] = React.useState<HomeReminder[] | null>(null);
    const [access, setAccess] = React.useState<'unknown' | 'connected' | 'not-connected' | 'unsupported'>('unknown');
    const [draft, setDraft] = React.useState('');
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);

    const load = React.useCallback(async (connect = false) => {
        if (!supported) return;
        setError('');
        const next = await readHomeReminders(connect);
        setAccess(next.access);
        setItems(next.reminders);
        if (next.error) setError(next.error);
    }, [supported]);

    React.useEffect(() => { void load().catch(() => setError('Could not read reminders.')); }, [load]);

    const add = async () => {
        const title = draft.trim();
        if (!title) return;
        setBusy(true);
        setError('');
        try {
            const due = new Date();
            due.setHours(18, 0, 0, 0);
            await saveHomeReminder(title, due.toISOString());
            setDraft('');
            await load();
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'Could not add that reminder.');
        } finally {
            setBusy(false);
        }
    };

    const complete = async (id: string) => {
        setItems((current) => current?.filter((item) => item.id !== id) ?? current);
        try {
            await completeHomeReminder(id);
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'Could not complete that reminder.');
            void load();
        }
    };

    return <section className="oc-home-week">
        <h2 className="oc-home-card-heading">
            <Icon name="calendar" className="size-3.5" />
            This week
            {items ? <span className="oc-home-count">{items.length}</span> : null}
            <form className="ml-auto flex min-w-0 items-center gap-1" onSubmit={(event) => { event.preventDefault(); void add(); }}>
                <Input value={draft} disabled={!supported || access !== 'connected' || busy} aria-label="Add a reminder for today" placeholder="Add" className="h-7 w-28 text-xs" onChange={(event) => setDraft(event.target.value)} />
            </form>
        </h2>
        {!supported ? <p className="oc-home-empty">Reminders are available in the desktop app.</p>
            : access !== 'connected' ? <div className="space-y-2">
                <p className="oc-home-empty">Connect Reminders to keep this week's list here.</p>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { setBusy(true); void load(true).finally(() => setBusy(false)); }}>{busy ? 'Waiting…' : 'Connect Reminders'}</Button>
            </div>
            : items?.length ? <ul className="space-y-1">
                {items.map((item) => <li key={item.id} className="oc-home-week-row">
                    <button type="button" className="oc-home-week-check" aria-label={`Complete ${item.title}`} onClick={() => void complete(item.id)} />
                    <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
                    {item.priority === 'high' || item.priority === 'medium' ? <span className={cn('oc-home-week-flag', item.priority === 'high' && 'oc-home-week-flag-high')} title={item.priority === 'high' ? 'High' : 'Medium'} /> : null}
                    {item.due ? <span className={cn('oc-home-week-pill', item.overdue && 'oc-home-week-pill-overdue', dayLabel(item.due, item.overdue) === 'Today' && 'oc-home-week-pill-today')}>{dayLabel(item.due, item.overdue)}</span> : null}
                </li>)}
            </ul> : <p className="oc-home-empty">Nothing due this week.</p>}
        {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
    </section>;
}

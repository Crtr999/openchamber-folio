import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import type { HomeTeamRoutine, HomeTeamSchedule } from '@/lib/personal-home';

export function HomeTeamRoutineForm({ disabled, onPropose }: {
    disabled: boolean;
    onPropose: (schedule: HomeTeamSchedule, limits: HomeTeamRoutine['limits']) => void;
}) {
    const { t, locale } = useI18n();
    const [kind, setKind] = React.useState<HomeTeamSchedule['kind']>('weekly');
    const [time, setTime] = React.useState('');
    const [date, setDate] = React.useState('');
    const [cron, setCron] = React.useState('');
    const [timezone, setTimezone] = React.useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    const [weekdays, setWeekdays] = React.useState<number[]>([]);
    const [maxOccurrences, setMaxOccurrences] = React.useState('');
    const [tokenGuardrail, setTokenGuardrail] = React.useState('');
    const days = Array.from({ length: 7 }, (_, day) => new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 9, 11 + day))));
    return <details className="mt-3 text-sm">
        <summary className="cursor-pointer rounded-sm py-2 focus-visible:outline focus-visible:outline-ring">{t('home.teamReview')}</summary>
        <form className="space-y-3 pt-2" onSubmit={(event) => {
            event.preventDefault();
            if (disabled || (kind === 'weekly' && !weekdays.length)) return;
            const schedule: HomeTeamSchedule = kind === 'cron' ? { kind, cron, timezone }
                : kind === 'once' ? { kind, date, time, timezone }
                    : kind === 'weekly' ? { kind, weekdays, time, timezone } : { kind, time, timezone };
            onPropose(schedule, { maxOccurrences: Number(maxOccurrences), tokenGuardrail: Number(tokenGuardrail) });
        }}>
            <SettingsStackedField label={t('home.teamSchedule')}><Select value={kind} disabled={disabled} onValueChange={(value) => {
                if (value === 'weekly' || value === 'daily' || value === 'once' || value === 'cron') setKind(value);
            }}><SelectTrigger size="settings" aria-label={t('home.teamSchedule')}><SelectValue>{kind === 'daily' ? t('home.teamDaily') : kind === 'weekly' ? t('home.teamWeekly') : kind === 'once' ? t('home.teamOnce') : 'cron'}</SelectValue></SelectTrigger><SelectContent>
                <SelectItem value="weekly">{t('home.teamWeekly')}</SelectItem><SelectItem value="daily">{t('home.teamDaily')}</SelectItem><SelectItem value="once">{t('home.teamOnce')}</SelectItem><SelectItem value="cron">cron</SelectItem>
            </SelectContent></Select></SettingsStackedField>
            {kind === 'weekly' && <fieldset disabled={disabled}><legend className="mb-1 text-xs text-muted-foreground">{t('home.teamDays')}</legend><div className="flex flex-wrap gap-1">{days.map((label, day) => <Button key={day} type="button" variant="chip" size="xs" aria-pressed={weekdays.includes(day)} onClick={() => setWeekdays((previous) => previous.includes(day) ? previous.filter((item) => item !== day) : [...previous, day].sort())}>{label}</Button>)}</div></fieldset>}
            {kind === 'once' && <SettingsStackedField label={t('home.teamDate')}><Input type="date" required value={date} disabled={disabled} aria-label={t('home.teamDate')} onChange={(event) => setDate(event.target.value)} /></SettingsStackedField>}
            {kind === 'cron' ? <SettingsStackedField label="cron"><Input required maxLength={200} dir="ltr" value={cron} disabled={disabled} aria-label="cron" onChange={(event) => setCron(event.target.value)} /></SettingsStackedField>
                : <SettingsStackedField label={t('home.teamTime')}><Input type="time" required value={time} disabled={disabled} aria-label={t('home.teamTime')} onChange={(event) => setTime(event.target.value)} /></SettingsStackedField>}
            <SettingsStackedField label={t('home.teamZone')}><Input required maxLength={100} dir="ltr" value={timezone} disabled={disabled} aria-label={t('home.teamZone')} onChange={(event) => setTimezone(event.target.value)} /></SettingsStackedField>
            <SettingsStackedField label={t('home.teamOccurrences')}><Input type="number" min={1} max={31} step={1} required value={maxOccurrences} disabled={disabled} aria-label={t('home.teamOccurrences')} onChange={(event) => setMaxOccurrences(event.target.value)} /></SettingsStackedField>
            <SettingsStackedField label={t('home.teamTokens')}><Input type="number" min={1} max={10000000} step={1} required value={tokenGuardrail} disabled={disabled} aria-label={t('home.teamTokens')} onChange={(event) => setTokenGuardrail(event.target.value)} /></SettingsStackedField>
            <p className="text-xs leading-relaxed text-muted-foreground">{t('home.teamReadOnly')}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{t('home.teamBilling')}</p>
            <Button type="submit" size="sm" variant="outline" disabled={disabled || (kind === 'weekly' && !weekdays.length)}>{t('home.teamReview')}</Button>
        </form>
    </details>;
}

export function HomeTeamRoutineReview({ routine, projectLabel, busy, onConfirm, onPause }: {
    routine: HomeTeamRoutine; projectLabel: string; busy: boolean; onConfirm: () => void; onPause: () => void;
}) {
    const { t, locale } = useI18n();
    const schedule = routine.schedule;
    const kind = schedule.kind === 'daily' ? t('home.teamDaily') : schedule.kind === 'weekly' ? t('home.teamWeekly') : schedule.kind === 'once' ? t('home.teamOnce') : 'cron';
    const days = schedule.kind === 'weekly' ? schedule.weekdays.map((day) => new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 9, 11 + day)))).join(', ') : '';
    return <article className="space-y-2 border-t border-border py-3 text-sm" aria-label={routine.title}>
        <h4 className="break-words font-medium" dir="auto">{routine.title}</h4>
        <p className="whitespace-pre-wrap break-words" dir="auto">{routine.text}</p>
        <p>{routine.status === 'proposed' ? t('home.teamProposed') : routine.status === 'confirmed' ? t('home.teamConfirmed') : routine.status === 'paused' ? t('home.aiPaused') : t('home.aiDone')}</p>
        {routine.failure && <p role="alert" dir="auto" className="break-words text-destructive">{t('home.aiFailureStage', { stage: routine.failure.stage, code: routine.failure.code })} {routine.failure.message}</p>}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs leading-relaxed">
            <dt className="text-muted-foreground">{t('home.aiProject')}</dt><dd dir="auto" className="break-all">{projectLabel}</dd>
            <dt className="text-muted-foreground">{t('home.teamSchedule')}</dt><dd className="break-words">{kind} {days} <bdi dir="ltr">{schedule.kind === 'cron' ? schedule.cron : `${schedule.kind === 'once' ? schedule.date : ''} ${schedule.time}`} {schedule.timezone}</bdi></dd>
            <dt className="text-muted-foreground">{t('home.teamOccurrences')}</dt><dd>{routine.occurrences} / {routine.limits.maxOccurrences}</dd>
            <dt className="text-muted-foreground">{t('home.teamTokens')}</dt><dd>{routine.limits.tokenGuardrail.toLocaleString(locale)}</dd>
        </dl>
        <p className="text-xs text-muted-foreground">{t('home.teamReadOnly')}</p>
        <p className="text-xs text-muted-foreground">{t('home.teamBilling')}</p>
        <p className="text-xs text-muted-foreground">{t('home.teamThresholds', { project: (100000).toLocaleString(locale), account: (250000).toLocaleString(locale) })}</p>
        {routine.nextRunAt !== undefined && <p>{t('home.teamNext', { date: new Date(routine.nextRunAt).toLocaleString(locale) })}</p>}
        <p className="break-all text-xs text-muted-foreground" dir="ltr">{routine.id} · {routine.revision} · {routine.policyRevision}</p>
        {routine.status === 'proposed' && <Button size="sm" disabled={busy} onClick={onConfirm}>{t('home.teamConfirm')}</Button>}
        {(routine.status === 'confirmed' || routine.status === 'proposed') && <Button size="sm" variant="ghost" disabled={busy} onClick={onPause}>{t('home.teamPause')}</Button>}
    </article>;
}

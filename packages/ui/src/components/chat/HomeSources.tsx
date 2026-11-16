import React from 'react';
import { useI18n } from '@/lib/i18n';
import { homeSourceStates, type HomeSourceEvidence } from './homeSourceState';
import type { HomeReadObservation, HomeSourceReads } from './useHomeSourceReads';

function HomeReadTime({ observation, showFailure = false }: { observation: HomeReadObservation; showFailure?: boolean }) {
    const { t, locale } = useI18n();
    const readAt = observation.kind === 'unknown' ? null : observation.readAt;
    return <div data-read-state={observation.kind}>
        {showFailure && observation.kind === 'failed' && <p>{t('home.sources.failed')}</p>}
        {readAt === null ? <p>{t('home.sources.readUnknown')}</p> : <time dateTime={new Date(readAt).toISOString()}>
            {t('home.sources.lastRead', { time: new Date(readAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'medium' }) })}
        </time>}
    </div>;
}

/** Read-only projection of the existing Home flow. Mounting never reads personal content. */
export function HomeSources(evidence: HomeSourceEvidence & { reads: HomeSourceReads }) {
    const { t } = useI18n();
    const states = homeSourceStates({ ...evidence, calendarFailed: evidence.calendarFailed || evidence.reads.calendar.kind === 'failed' });
    return <section className="oc-home-sources space-y-2 text-xs text-muted-foreground" aria-label={t('home.sources.title')}>
        <h2 className="font-medium text-foreground">{t('home.sources.title')}</h2>
        <dl className="flex flex-wrap gap-x-6 gap-y-2">
            {(['notion', 'calendar'] as const).map((source) => <div key={source} className="min-w-0 space-y-1">
                <dt className="font-medium text-foreground">{t(`home.sources.${source}`)}</dt>
                <dd className="max-w-prose break-words space-y-1">
                    <p>{t(`home.sources.${states[source]}`)}</p>
                    {source === 'notion' && evidence.supported && !evidence.blocked && !evidence.networkBlocked && evidence.notion?.connected && <dl className="space-y-1">
                        {(['board', 'habits'] as const).map((content) => <div key={content}>
                            <dt>{t(content === 'board' ? 'home.tasks' : 'home.habits')}</dt>
                            <dd><HomeReadTime observation={evidence.reads[content]} showFailure /></dd>
                        </div>)}
                    </dl>}
                    {source === 'calendar' && evidence.supported && <HomeReadTime observation={evidence.reads.calendar} />}
                </dd>
            </div>)}
        </dl>
        <p>{t('home.sources.readMeaning')}</p>
    </section>;
}

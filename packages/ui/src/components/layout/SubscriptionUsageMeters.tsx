import React from 'react';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { preloadProviderLogos } from '@/hooks/useProviderLogo';
import { useI18n } from '@/lib/i18n';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { clampPercent, formatQuotaResetLabel, formatQuotaValueLabel, formatWindowLabel, resolveUsageTone } from '@/lib/quota';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useQuotaAutoRefresh, useQuotaStore } from '@/stores/useQuotaStore';
import { useUIStore } from '@/stores/useUIStore';
import type { QuotaProviderId, UsageWindow } from '@/types';
import { pickSubscriptionRings, type SubscriptionRing } from './subscriptionUsageRings';

const METERS: Array<{ id: QuotaProviderId; name: string }> = [
  { id: 'codex', name: 'ChatGPT' },
  { id: 'xai', name: 'Grok' },
  { id: 'claude', name: 'Claude' },
  { id: 'gemini-website', name: 'Gemini' },
  { id: 'venice-website', name: 'Venice' },
];

const SIZE = 32;
const CENTER = SIZE / 2;
const STROKE = 2.25;
const OUTER_RADIUS = 13.5;
const INNER_RADIUS = 9.5;

const toneColor = (usedPercent: number | null): string => {
  const tone = resolveUsageTone(usedPercent);
  if (tone === 'critical') return 'var(--status-error)';
  if (tone === 'warn') return 'var(--status-warning)';
  return usedPercent === null ? 'var(--interactive-border)' : 'var(--status-success)';
};

const UsageRing: React.FC<{
  radius: number;
  usedPercent: number | null;
  failed: boolean;
}> = ({ radius, usedPercent, failed }) => {
  const circumference = 2 * Math.PI * radius;
  const used = clampPercent(usedPercent);
  const offset = used === null ? circumference : circumference * (1 - used / 100);
  return (
    <>
      <circle
        cx={CENTER}
        cy={CENTER}
        r={radius}
        fill="none"
        stroke={failed && used === null ? 'var(--status-error)' : 'var(--interactive-border)'}
        strokeWidth={STROKE}
        strokeDasharray={used === null ? '3 2' : undefined}
      />
      {used !== null && used > 0 ? (
        <circle
          cx={CENTER}
          cy={CENTER}
          r={radius}
          fill="none"
          stroke={toneColor(used)}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      ) : null}
    </>
  );
};

const ringSummary = (
  ring: SubscriptionRing,
  place: 'inner' | 'outer' | null,
  usedWord: string,
  leftWord: string,
): string => {
  const label = formatWindowLabel(ring.key);
  const used = formatQuotaValueLabel(null, ring.window.usedPercent);
  const left = formatQuotaValueLabel(null, ring.window.remainingPercent);
  const placed = place ? `${label} (${place})` : label;
  return `${placed} ${used} ${usedWord}, ${left} ${leftWord}`;
};

type MeterModel = {
  id: QuotaProviderId;
  name: string;
  planLabel: string | null;
  outer: SubscriptionRing | null;
  inner: SubscriptionRing | null;
  extras: Array<{ key: string; window: UsageWindow }>;
  error: string | null;
  fetching: boolean;
};

const ringLines = (ring: SubscriptionRing, place: 'inner' | 'outer' | null) => {
  const used = clampPercent(ring.window.usedPercent);
  const left = clampPercent(ring.window.remainingPercent) ?? (used === null ? null : 100 - used);
  return {
    label: place ? `${formatWindowLabel(ring.key)} (${place})` : formatWindowLabel(ring.key),
    usedLabel: formatQuotaValueLabel(null, used),
    leftLabel: formatQuotaValueLabel(null, left),
    tone: toneColor(used),
  };
};

const MeterDetails: React.FC<{ meter: MeterModel }> = ({ meter }) => {
  const { t } = useI18n();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const rings = [meter.inner, meter.outer].filter((ring): ring is SubscriptionRing => ring !== null);
  const leftWord = t('header.services.remaining');

  return (
    <div className="w-52 px-2 py-1.5 text-foreground">
      <p className="mb-2 font-medium">{meter.planLabel ? `${meter.name} · ${meter.planLabel}` : meter.name}</p>
      <div className="space-y-2">
        {rings.map((ring) => {
          const placeName = rings.length > 1 ? (ring === meter.inner ? 'inner' : 'outer') : null;
          const line = ringLines(ring, placeName);
          const reset = formatQuotaResetLabel(
            ring.window.resetAt,
            ring.window.resetAfterFormatted ?? ring.window.resetAtFormatted,
            timeFormatPreference,
          );
          return (
            <div key={ring.key}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-muted-foreground">{line.label}</span>
                <span className="shrink-0 text-base font-semibold tabular-nums">{line.usedLabel}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                <span className="mr-1.5 inline-block size-1.5 rounded-full align-middle" style={{ background: line.tone }} />
                {line.leftLabel} {leftWord}
                {reset ? ` · ${reset}` : ''}
              </p>
            </div>
          );
        })}
        {meter.extras.map((extra) => (
          <p key={extra.key} className="text-xs text-muted-foreground">
            {formatWindowLabel(extra.key)} · {formatQuotaValueLabel(extra.window.valueLabel, extra.window.usedPercent)}
          </p>
        ))}
        {rings.length === 0 && meter.extras.length === 0 && !meter.error ? (
          <p className="text-xs text-muted-foreground">{t('header.services.noRateLimitsReported')}</p>
        ) : null}
        {meter.error ? <p className="text-xs text-[var(--status-error)]">{meter.error}</p> : null}
      </div>
    </div>
  );
};

const MeterButton: React.FC<{
  meter: MeterModel;
  onOpen: () => void;
}> = ({ meter, onOpen }) => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const pinned = React.useRef(false);
  const closeTimer = React.useRef<number | null>(null);
  const rings = [meter.inner, meter.outer].filter((ring): ring is SubscriptionRing => ring !== null);
  const failed = Boolean(meter.error) && rings.length === 0;
  const usedWord = t('header.services.used');
  const leftWord = t('header.services.remaining');
  const summary = [
    meter.name,
    meter.planLabel,
    ...rings.map((ring) => ringSummary(
      ring,
      rings.length > 1 ? (ring === meter.inner ? 'inner' : 'outer') : null,
      usedWord,
      leftWord,
    )),
    meter.error,
  ].filter(Boolean).join('. ');

  const clearClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const show = () => {
    clearClose();
    setOpen(true);
  };
  const hide = () => {
    clearClose();
    closeTimer.current = window.setTimeout(() => {
      if (!pinned.current) setOpen(false);
    }, 180);
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next, details) => {
        if (!next) {
          pinned.current = false;
          setOpen(false);
          return;
        }
        if (details.reason === 'trigger-press') {
          pinned.current = true;
          onOpen();
        }
        setOpen(true);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-subscription-usage={meter.id}
          aria-label={summary}
          title={summary}
          aria-busy={meter.fetching}
          onMouseEnter={show}
          onMouseLeave={hide}
          onFocus={show}
          className="app-region-no-drag relative inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="size-8 -rotate-90" aria-hidden>
            {meter.outer ? <UsageRing radius={OUTER_RADIUS} usedPercent={meter.outer.window.usedPercent} failed={failed} /> : null}
            {meter.inner ? <UsageRing radius={INNER_RADIUS} usedPercent={meter.inner.window.usedPercent} failed={failed} /> : null}
            {!meter.outer && !meter.inner ? <UsageRing radius={OUTER_RADIUS} usedPercent={null} failed={failed} /> : null}
          </svg>
          <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <ProviderLogo providerId={meter.id} alt="" className={meter.inner ? 'size-3' : 'size-4'} />
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="end"
        className="!bg-background p-0 shadow-2xl"
        onMouseEnter={clearClose}
        onMouseLeave={hide}
      >
        <MeterDetails meter={meter} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/**
 * Always-visible subscription meters for the three native plans.
 *
 * Each configured service is its logo with up to two rings. The outer ring is
 * the weekly (or 7-day) window. The inner ring is the current 5-hour window
 * when the service reports one. Grok reports a single billing-cycle pool, so
 * it gets one ring rather than a second invented window.
 */
export const SubscriptionUsageMeters: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useI18n();
  const results = useQuotaStore((state) => state.currentResults);
  const refreshErrors = useQuotaStore((state) => state.refreshErrors);
  const isFetchingProvider = useQuotaStore((state) => state.isFetchingProvider);
  const fetchProviderQuota = useQuotaStore((state) => state.fetchProviderQuota);
  const ensureLoadedForRuntime = useQuotaStore((state) => state.ensureLoadedForRuntime);
  const isInitialized = useConfigStore((state) => state.isInitialized);

  useQuotaAutoRefresh();

  React.useEffect(() => {
    if (!isInitialized) return;
    void runBackgroundNetworkTask(() => ensureLoadedForRuntime());
  }, [ensureLoadedForRuntime, isInitialized]);

  const meters = METERS.flatMap((meta) => {
    const result = results.find((entry) => entry.providerId === meta.id);
    if (!result?.configured) return [];
    const rings = pickSubscriptionRings(result.usage?.windows);
    const ringKeys = new Set([rings.outer?.key, rings.inner?.key].filter(Boolean));
    const extras = Object.entries(result.usage?.windows ?? {})
      .filter(([key, window]) => !ringKeys.has(key) && (window.valueLabel || window.usedPercent !== null))
      .map(([key, window]) => ({ key, window }));
    const error = refreshErrors[meta.id] ?? (!result.ok ? result.error ?? null : null);
    return [{ ...meta, ...rings, extras, planLabel: result.planLabel ?? null, error, fetching: Boolean(isFetchingProvider[meta.id]) }];
  });

  const meterIds = meters.map((meter) => meter.id).join(',');
  React.useEffect(() => {
    if (!meterIds) return;
    preloadProviderLogos(meterIds.split(','));
  }, [meterIds]);

  if (meters.length === 0) return null;

  return (
    <div role="group" aria-label={t('header.services.rateLimits')} className={cn('mr-1 flex items-center', className)}>
      {meters.map((meter) => (
        <MeterButton
          key={meter.id}
          meter={meter}
          onOpen={() => { void fetchProviderQuota(meter.id); }}
        />
      ))}
    </div>
  );
};

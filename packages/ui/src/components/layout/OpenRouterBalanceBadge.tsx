import React from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { canUseElectronDesktopIPC, isDesktopLocalOriginActive, openRouterCreditsCommand, type OpenRouterCreditsStatus } from '@/lib/desktop';
import { openExternalUrl } from '@/lib/url';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

const formatDollars = (amount: number) => `$${amount.toFixed(amount >= 100 ? 0 : 2)}`;
const cleanIpcMessage = (message: string) => message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** The official native OpenRouter feed. No other provider readers mount here. */
export function OpenRouterBalanceBadge() {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<OpenRouterCreditsStatus>();
  const [open, setOpen] = React.useState(false);
  const [key, setKey] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [runtimeRevision, changeRuntime] = React.useReducer(value => value + 1, 0);

  React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
    setStatus(undefined); setOpen(false); setKey(''); setError(''); setBusy(false); changeRuntime();
  }), []);

  React.useEffect(() => {
    let alive = true;
    if (!canUseElectronDesktopIPC() || !isDesktopLocalOriginActive()) return;
    const runtime = getRuntimeKey();
    const load = (action: 'status' | 'refresh') => { void openRouterCreditsCommand({ action }).then((next) => { if (alive && runtime === getRuntimeKey() && isDesktopLocalOriginActive()) setStatus(next); }).catch(() => undefined); };
    load('refresh');
    const timer = setInterval(() => load('refresh'), 300_000);
    const onFocus = () => load('refresh');
    window.addEventListener('focus', onFocus);
    return () => { alive = false; clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [runtimeRevision]);

  React.useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);

  if (!status || !isDesktopLocalOriginActive()) return null;
  const act = async (input: Parameters<typeof openRouterCreditsCommand>[0]) => {
    const runtime = getRuntimeKey();
    setBusy(true); setError('');
    try {
      const next = await openRouterCreditsCommand(input);
      if (runtime === getRuntimeKey() && isDesktopLocalOriginActive()) { setStatus(next); setKey(''); }
    }
    catch (caught) { if (runtime === getRuntimeKey()) setError(cleanIpcMessage(caught instanceof Error ? caught.message : String(caught))); }
    finally { if (runtime === getRuntimeKey()) setBusy(false); }
  };
  // Older native hosts may still return spending. Never use it as this counter.
  const balance = status.balance?.kind === 'spent' ? undefined : status.balance;
  const label = balance ? formatDollars(balance.amount) : undefined;
  const meaning = balance ? t(balance.kind === 'account' ? 'openrouter.credits.account' : 'openrouter.credits.limit') : t('openrouter.credits.managementHint');
  const lowBalance = balance && balance.amount < 2;

  return <div className="relative">
    <Button
      type="button"
      variant="ghost" size="icon"
      className="app-region-no-drag rounded-md text-muted-foreground"
      style={lowBalance ? { color: 'var(--status-warning)' } : undefined}
      aria-expanded={open}
      aria-label={[t('openrouter.credits.title'), label, meaning].filter(Boolean).join(' · ')}
      title={[t('openrouter.credits.title'), label, meaning, error || status.error].filter(Boolean).join(' · ')}
      onClick={() => { const next = !open; setOpen(next); if (next) void act({ action: 'refresh' }); }}
    >
      <Icon name="coin" className="size-[18px]" /><span className="sr-only">{label ?? t(status.configured ? 'openrouter.credits.unavailable' : 'openrouter.credits.add')}</span>
    </Button>
    {open && createPortal(<>
      <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
      <div role="dialog" aria-label={t('openrouter.credits.title')} className="fixed right-14 top-20 z-50 w-80 max-w-[calc(100vw-4rem)] rounded-xl border border-border bg-background p-3 text-sm shadow-2xl" onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}>
        <div className="mb-1 font-medium">{t('openrouter.credits.title')}</div>
        {balance && <p className="mb-1"><span className="text-lg font-semibold tabular-nums">{label}</span> <span className="text-muted-foreground">· {meaning}</span></p>}
        {balance && <p className="mb-2 text-xs text-muted-foreground">{t('openrouter.credits.checked', { time: new Date(balance.checked).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) })}</p>}
        {balance?.kind !== 'account' && <p className="mb-2 text-xs text-muted-foreground">{t('openrouter.credits.managementHint')}</p>}
        {balance?.kind !== 'account' && <Button type="button" size="sm" variant="outline" className="mb-2" onClick={() => { void openExternalUrl('https://openrouter.ai/settings/management-keys'); }}>{t('openrouter.credits.add')}</Button>}
        <p className="mb-2 text-xs text-muted-foreground">{t(status.source === 'saved' ? 'openrouter.credits.sourceSaved' : status.source === 'opencode' ? 'openrouter.credits.sourceOpencode' : 'openrouter.credits.none')}</p>
        {(error || status.error) && <p role="alert" className="mb-2 text-xs text-[var(--status-error)]">{error || status.error}</p>}
        <form className="mb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void act({ action: 'set-key', key }); }}>
          <input type="password" autoComplete="off" spellCheck={false} className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5" placeholder={t('openrouter.credits.keyPlaceholder')} aria-label={t('openrouter.credits.keyPlaceholder')} value={key} onChange={(e) => setKey(e.target.value)} />
          <button type="submit" className="rounded-md bg-secondary px-2.5 disabled:opacity-50" disabled={busy || !key.trim()}>{t('openrouter.credits.save')}</button>
        </form>
        {status.configured && <label className="mb-3 flex items-center gap-2"><input type="checkbox" checked={status.menuBar} onChange={(e) => void act({ action: 'menu-bar', show: e.target.checked })} />{t('openrouter.credits.menuBar')}</label>}
        <div className="flex gap-2">
          <button type="button" className="flex-1 rounded-md bg-secondary px-2.5 py-1.5 disabled:opacity-50" disabled={busy} onClick={() => void act({ action: 'refresh' })}>{t('openrouter.credits.refresh')}</button>
          <button type="button" className="rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-interactive-hover" onClick={() => { void openExternalUrl('https://openrouter.ai/settings/credits'); }}>{t('openrouter.credits.addCredits')}</button>
          {status.source === 'saved' && <button type="button" className="rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-interactive-hover" disabled={busy} onClick={() => void act({ action: 'clear' })}>{t('openrouter.credits.remove')}</button>}
        </div>
      </div>
    </>, document.body)}
  </div>;
}

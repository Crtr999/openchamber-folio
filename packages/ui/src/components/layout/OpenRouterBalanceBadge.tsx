import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { openRouterCreditsCommand, type OpenRouterCreditsStatus } from '@/lib/desktop';
import { openExternalUrl } from '@/lib/url';

const formatDollars = (amount: number) => `$${amount.toFixed(amount >= 100 ? 0 : 2)}`;
const cleanIpcMessage = (message: string) => message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** OpenRouter balance in the header (desktop app only; renders nothing elsewhere).
 *  The main process refreshes every five minutes; this picks up its latest answer each minute. */
export function OpenRouterBalanceBadge() {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<OpenRouterCreditsStatus>();
  const [open, setOpen] = React.useState(false);
  const [key, setKey] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    let alive = true;
    const load = () => { void openRouterCreditsCommand({ action: 'status' }).then((next) => { if (alive) setStatus(next); }).catch(() => undefined); };
    load();
    const timer = setInterval(load, 60_000);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => { alive = false; clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, []);

  if (!status) return null;
  const act = async (input: Parameters<typeof openRouterCreditsCommand>[0]) => {
    setBusy(true); setError('');
    try { setStatus(await openRouterCreditsCommand(input)); setKey(''); }
    catch (caught) { setError(cleanIpcMessage(caught instanceof Error ? caught.message : String(caught))); }
    finally { setBusy(false); }
  };
  const balance = status.balance;
  const label = balance ? (balance.kind === 'spent' ? t('openrouter.credits.spent', { amount: formatDollars(balance.amount) }) : formatDollars(balance.amount)) : undefined;
  const meaning = balance ? t(balance.kind === 'account' ? 'openrouter.credits.account' : balance.kind === 'limit' ? 'openrouter.credits.limit' : 'openrouter.credits.spentHint') : '';
  const lowBalance = balance && balance.kind !== 'spent' && balance.amount < 2;

  return <div className="relative">
    <button
      type="button"
      className="flex h-7 items-center gap-1 rounded-full px-2 text-xs tabular-nums text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
      style={lowBalance ? { color: 'var(--status-warning)' } : undefined}
      aria-expanded={open}
      title={meaning ? `${t('openrouter.credits.title')} · ${meaning}` : t('openrouter.credits.title')}
      onClick={() => { const next = !open; setOpen(next); if (next) void act({ action: 'refresh' }); }}
    >
      <Icon name="coin" className="size-3.5" />{label ?? t('openrouter.credits.add')}
    </button>
    {open && <>
      <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
      <div className="absolute right-0 top-9 z-50 w-80 rounded-xl border border-border bg-background p-3 text-sm shadow-2xl">
        <div className="mb-1 font-medium">{t('openrouter.credits.title')}</div>
        {balance && <p className="mb-1"><span className="text-lg font-semibold tabular-nums">{label}</span> <span className="text-muted-foreground">· {meaning}</span></p>}
        {balance && <p className="mb-2 text-xs text-muted-foreground">{t('openrouter.credits.checked', { time: new Date(balance.checked).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) })}</p>}
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
    </>}
  </div>;
}

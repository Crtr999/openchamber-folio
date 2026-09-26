import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { formatDollars } from '@/lib/folio/credits';
import { openRouterCreditsCommand, type OpenRouterCreditsStatus } from '@/lib/desktop';

/** OpenRouter balance next to "Saved" on the Mac, with a small panel to add the key and choose the menu bar item. */
export function FolioCreditsBadge() {
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
    // The main process refreshes every five minutes; this only picks up its latest answer.
    const timer = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  if (!status) return null;
  const act = async (input: Parameters<typeof openRouterCreditsCommand>[0]) => {
    setBusy(true); setError('');
    try { setStatus(await openRouterCreditsCommand(input)); setKey(''); }
    catch (caught) { setError(caught instanceof Error ? caught.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(caught)); }
    finally { setBusy(false); }
  };
  const balance = status.balance;
  const label = balance ? (balance.kind === 'spent' ? t('folio.creditsSpent', { amount: formatDollars(balance.amount) }) : formatDollars(balance.amount)) : undefined;
  const meaning = balance ? t(balance.kind === 'account' ? 'folio.creditsAccount' : balance.kind === 'limit' ? 'folio.creditsLimit' : 'folio.creditsSpentHint') : '';

  return <div className="relative">
    <button type="button" className="flex h-7 items-center gap-1 rounded-full px-2 text-xs tabular-nums text-muted-foreground hover:bg-interactive-hover" aria-expanded={open} title={meaning || t('folio.creditsTitle')} onClick={() => setOpen(!open)}>
      <Icon name="coin" className="size-3.5" />{label ?? t('folio.creditsAdd')}
    </button>
    {open && <>
      <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
      <div className="absolute right-0 top-9 z-50 w-80 rounded-xl border border-border bg-background p-3 text-sm shadow-2xl">
        <div className="mb-1 font-medium">{t('folio.creditsTitle')}</div>
        {balance && <p className="mb-2"><span className="text-lg font-semibold tabular-nums">{label}</span> <span className="text-muted-foreground">· {meaning}</span></p>}
        {balance && <p className="mb-2 text-xs text-muted-foreground">{t('folio.creditsChecked', { time: new Date(balance.checked).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) })}</p>}
        {(error || status.error) && <p role="alert" className="mb-2 text-xs text-[var(--status-error)]">{error || status.error}</p>}
        <form className="mb-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); void act({ action: 'set-key', key }); }}>
          <input type="password" autoComplete="off" spellCheck={false} className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5" placeholder={status.configured ? '••••••••' : t('folio.creditsKeyPlaceholder')} aria-label={t('folio.creditsKeyPlaceholder')} value={key} onChange={(e) => setKey(e.target.value)} />
          <button type="submit" className="rounded-md bg-secondary px-2.5 disabled:opacity-50" disabled={busy || !key.trim()}>{t('folio.save')}</button>
        </form>
        <p className="mb-3 text-xs text-muted-foreground">{t('folio.creditsKeyHint')}</p>
        {status.configured && <>
          <label className="mb-3 flex items-center gap-2"><input type="checkbox" checked={status.menuBar} onChange={(e) => void act({ action: 'menu-bar', show: e.target.checked })} />{t('folio.creditsMenuBar')}</label>
          <div className="flex gap-2">
            <button type="button" className="flex-1 rounded-md bg-secondary px-2.5 py-1.5 disabled:opacity-50" disabled={busy} onClick={() => void act({ action: 'refresh' })}>{t('folio.creditsRefresh')}</button>
            <button type="button" className="rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-interactive-hover" disabled={busy} onClick={() => void act({ action: 'clear' })}>{t('folio.creditsRemove')}</button>
          </div>
        </>}
      </div>
    </>}
  </div>;
}

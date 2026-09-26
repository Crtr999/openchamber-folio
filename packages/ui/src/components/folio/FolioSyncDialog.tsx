import React from 'react';
import QRCode from 'qrcode';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { folioSyncCommand, type FolioSyncStatus } from '@/lib/desktop';

/** Mac side of iPhone sync: turn it on, show the pairing code, or turn it off. */
export function FolioSyncDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<FolioSyncStatus>();
  const [qr, setQR] = React.useState('');
  const [error, setError] = React.useState('');
  const [copied, setCopied] = React.useState(false);

  const run = React.useCallback(async (action: 'status' | 'enable' | 'disable') => {
    try { setStatus(await folioSyncCommand(action)); setError(''); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }, []);
  React.useEffect(() => { void run('status'); const timer = setInterval(() => void run('status'), 5000); return () => clearInterval(timer); }, [run]);
  React.useEffect(() => {
    if (!status?.pairingURL) { setQR(''); return; }
    void QRCode.toDataURL(status.pairingURL, { margin: 1, width: 240 }).then(setQR).catch(() => setQR(''));
  }, [status?.pairingURL]);

  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
    <div role="dialog" aria-label={t('folio.syncTitle')} className="w-full max-w-md rounded-2xl border border-border bg-background p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
      <div className="mb-3 flex items-center gap-2">
        <Icon name="smartphone" className="size-5 text-muted-foreground" />
        <h2 className="flex-1 font-semibold">{t('folio.syncTitle')}</h2>
        <button type="button" className="rounded-md p-1 text-muted-foreground hover:bg-interactive-hover" aria-label={t('folio.close')} onClick={onClose}><Icon name="close" className="size-4" /></button>
      </div>
      {error && <p role="alert" className="mb-3 text-sm text-[var(--status-error)]">{error}</p>}
      {!status?.enabled ? <>
        <p className="mb-4 text-sm text-muted-foreground">{t('folio.syncIntro')}</p>
        <button type="button" className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground" onClick={() => void run('enable')}>{t('folio.syncTurnOn')}</button>
      </> : <>
        <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>{t('folio.syncStepCamera')}</li>
          <li>{t('folio.syncStepAllow')}</li>
        </ol>
        {qr && <img src={qr} alt={t('folio.syncTitle')} className="mx-auto mb-3 size-60 rounded-lg bg-white p-2" />}
        <button type="button" className="mb-3 w-full rounded-lg bg-secondary px-3 py-2 text-sm" onClick={() => { if (status.pairingURL) void navigator.clipboard.writeText(status.pairingURL).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
          {copied ? '✓' : t('folio.syncCopyLink')}
        </button>
        <p className="mb-4 text-xs text-muted-foreground">
          {status.lastSync ? t('folio.syncLast', { time: new Date(status.lastSync).toLocaleTimeString() }) : t('folio.syncWaiting')}
          {!status.listening && ` ${t('folio.syncNotListening')}`}
        </p>
        <button type="button" className="w-full rounded-lg px-3 py-2 text-sm text-[var(--status-error)] hover:bg-interactive-hover" onClick={() => void run('disable')}>{t('folio.syncTurnOff')}</button>
      </>}
    </div>
  </div>;
}

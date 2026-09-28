import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { chatProviders, listModels, type ChatModel, type ProviderID } from '@/lib/folio/mobile-chat';
import type { LocalEngine } from '@/lib/folio/local-engine';
import { useFolioStore } from '@/lib/folio/store';
import type { Theme, ThemeMode } from '@/types/theme';
import { readKey, useMobileChatStore, writeKey } from './chatStore';
import { nativeGet } from './host';
import { useSyncStore } from './sync';
import { useBalanceStore } from './balance';
import { formatDollars } from '@/lib/folio/credits';

const section = 'mb-6 rounded-xl border border-border/70 p-4';

const APPEARANCE_MODES: readonly { mode: ThemeMode; labelKey: I18nKey }[] = [
  { mode: 'system', labelKey: 'folio.appearanceSystem' },
  { mode: 'light', labelKey: 'folio.appearanceLight' },
  { mode: 'dark', labelKey: 'folio.appearanceDark' },
];

/** The Mac drops the variant suffix from a theme's name, so the same theme reads the same on both. */
const themeLabel = (name: string, variant: 'light' | 'dark'): string => {
  const suffix = variant === 'dark' ? ' Dark' : ' Light';
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
};

/**
 * The theme, from the same store the Mac reads and writes, so a choice made here is the one the Mac
 * shows and the one the next sync carries back. Picking a theme also makes it the active variant,
 * which is what the Mac's own theme picker does; the two variants are listed apart, as the Mac lists
 * them in two pickers, because most themes ship in both.
 */
export function AppearanceSection({ onThemeChanged }: { onThemeChanged: () => void }) {
  const { t } = useI18n();
  const { availableThemes, currentTheme, themeMode, setTheme, setThemeMode } = useThemeSystem();
  const groups = React.useMemo<readonly { labelKey: I18nKey; themes: Theme[] }[]>(() => {
    const byName = [...availableThemes].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
    return [
      { labelKey: 'folio.appearanceLight', themes: byName.filter((theme) => theme.metadata.variant === 'light') },
      { labelKey: 'folio.appearanceDark', themes: byName.filter((theme) => theme.metadata.variant === 'dark') },
    ];
  }, [availableThemes]);

  return <section className={section}>
    <h2 className="mb-1 font-semibold">{t('folio.appearance')}</h2>
    <p className="mb-3 text-xs text-muted-foreground">{t('folio.appearanceHint')}</p>
    <select
      className="mb-3 w-full rounded-lg border border-border bg-background px-2 py-2 text-sm"
      aria-label={t('folio.appearanceMode')}
      value={themeMode}
      onChange={(e) => {
        const next = APPEARANCE_MODES.find((option) => option.mode === e.target.value);
        if (!next) return;
        setThemeMode(next.mode);
        onThemeChanged();
      }}
    >
      {APPEARANCE_MODES.map((option) => <option key={option.mode} value={option.mode}>{t(option.labelKey)}</option>)}
    </select>
    <div className="max-h-64 overflow-y-auto">
      {groups.map((group) => <React.Fragment key={group.labelKey}>
        <p className="px-1 pb-1 pt-2 text-xs font-medium text-muted-foreground">{t(group.labelKey)}</p>
        {group.themes.map((theme) => <button key={theme.metadata.id} type="button" className="flex w-full items-center justify-between gap-2 border-b border-border/40 px-1 py-2 text-left text-sm" onClick={() => { setTheme(theme.metadata.id); onThemeChanged(); }}>
          <span className="min-w-0 truncate">{themeLabel(theme.metadata.name, theme.metadata.variant)}</span>
          {theme.metadata.id === currentTheme.metadata.id && <Icon name="check" className="size-4 shrink-0 text-muted-foreground" />}
        </button>)}
      </React.Fragment>)}
    </div>
  </section>;
}

function KeyField({ provider, name, hint }: { provider: ProviderID; name: string; hint: string }) {
  const { t } = useI18n();
  const [value, setValue] = React.useState('');
  const [saved, setSaved] = React.useState(false);
  const [has, setHas] = React.useState(false);
  React.useEffect(() => { void readKey(provider).then((key) => setHas(Boolean(key))); }, [provider]);
  return <form className="mb-3" onSubmit={(e) => { e.preventDefault(); void writeKey(provider, value).then(() => { setHas(Boolean(value.trim())); setValue(''); setSaved(true); setTimeout(() => setSaved(false), 1500); }); }}>
    <label className="mb-1 block text-sm font-medium">{name}{has && <span className="ml-2 text-xs font-normal text-muted-foreground">{t('folio.keySaved')}</span>}</label>
    <div className="flex gap-2">
      <input type="password" autoComplete="off" autoCapitalize="off" spellCheck={false} className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-[16px]" placeholder={has ? '••••••••' : hint} aria-label={name} value={value} onChange={(e) => setValue(e.target.value)} />
      <button type="submit" className="rounded-lg bg-secondary px-3 text-sm">{saved ? '✓' : t('folio.save')}</button>
    </div>
    <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
  </form>;
}

function BalanceSection() {
  const { t } = useI18n();
  const { balance, error, refresh, setBalanceKey } = useBalanceStore();
  const [value, setValue] = React.useState('');
  return <section className={section}>
    <h2 className="mb-1 font-semibold">{t('folio.creditsTitle')}</h2>
    <p className="mb-3 text-sm">{balance ? `${balance.kind === 'spent' ? t('folio.creditsSpent', { amount: formatDollars(balance.amount) }) : formatDollars(balance.amount)} · ${t(balance.kind === 'account' ? 'folio.creditsAccount' : balance.kind === 'limit' ? 'folio.creditsLimit' : 'folio.creditsSpentHint')}` : t('folio.creditsNone')}</p>
    {error && <p className="mb-2 text-xs text-muted-foreground">{error}</p>}
    <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void setBalanceKey(value).then(() => setValue('')); }}>
      <input type="password" autoComplete="off" autoCapitalize="off" spellCheck={false} className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-[16px]" placeholder={t('folio.creditsKeyPlaceholder')} aria-label={t('folio.creditsKeyPlaceholder')} value={value} onChange={(e) => setValue(e.target.value)} />
      <button type="submit" className="rounded-lg bg-secondary px-3 text-sm">{t('folio.save')}</button>
      <button type="button" className="rounded-lg bg-secondary px-3 text-sm" aria-label={t('folio.creditsRefresh')} onClick={() => void refresh()}><Icon name="refresh" className="size-4" /></button>
    </form>
    <p className="mt-1 text-xs text-muted-foreground">{t('folio.creditsKeyHint')}</p>
  </section>;
}

function SyncSection({ engine }: { engine: LocalEngine }) {
  const { t } = useI18n();
  const { pairing, lastSync, syncing, error, pair, unpair, syncNow } = useSyncStore();
  const [link, setLink] = React.useState('');
  const [bad, setBad] = React.useState(false);
  return <section className={section}>
    <h2 className="mb-1 font-semibold">{t('folio.syncTitle')}</h2>
    {pairing ? <>
      <p className="text-sm">{t('folio.syncPaired', { name: pairing.name })}</p>
      <p className="mb-3 text-xs text-muted-foreground">{error ? t('folio.syncUnreachable') : lastSync ? t('folio.syncPhoneLast', { time: new Date(lastSync).toLocaleString() }) : t('folio.syncWaiting')}</p>
      <div className="flex gap-2">
        <button type="button" className="flex-1 rounded-lg bg-secondary px-3 py-2 text-sm disabled:opacity-50" disabled={syncing} onClick={() => void syncNow(engine)}>{syncing ? '…' : t('folio.syncNow')}</button>
        <button type="button" className="rounded-lg px-3 py-2 text-sm text-[var(--status-error)]" onClick={() => void unpair()}>{t('folio.syncUnpair')}</button>
      </div>
    </> : <>
      <p className="mb-3 text-xs text-muted-foreground">{t('folio.syncPhoneIntro')}</p>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void pair(link, engine).then((ok) => { setBad(!ok); if (ok) setLink(''); }); }}>
        <input className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-[16px]" placeholder={t('folio.syncPaste')} aria-label={t('folio.syncPaste')} autoCapitalize="off" autoCorrect="off" value={link} onChange={(e) => { setLink(e.target.value); setBad(false); }} />
        <button type="submit" className="rounded-lg bg-secondary px-3 text-sm">{t('folio.syncPair')}</button>
      </form>
      {bad && <p role="alert" className="mt-2 text-xs text-[var(--status-error)]">{t('folio.syncBadLink')}</p>}
    </>}
  </section>;
}

/** Keys, models and backups for the standalone iPhone app. */
export function FolioMobileSettings({ engine, onMenu, onExportBackup }: { engine: LocalEngine; onMenu: () => void; onExportBackup: () => void }) {
  const { t } = useI18n();
  const syncNow = useSyncStore((s) => s.syncNow);
  const addModels = useMobileChatStore((s) => s.addModels);
  const [provider, setProvider] = React.useState<ProviderID>('openrouter');
  const [found, setFound] = React.useState<ChatModel[]>([]);
  const [filter, setFilter] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const loadModels = async () => {
    setBusy(true); setMessage('');
    try { setFound(await listModels(provider, await readKey(provider), nativeGet)); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const importBackup = async (file: File | undefined) => {
    if (!file) return;
    try { const count = await engine.importBackup(await file.text()); await useFolioStore.getState().refresh(); setMessage(t('folio.importedPages', { count })); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  const shown = found.filter((m) => `${m.name} ${m.id}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 60);

  return <div className="flex h-full flex-col bg-background text-foreground">
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border/60 px-2">
      <button type="button" className="flex size-9 items-center justify-center rounded-md text-muted-foreground" aria-label={t('folio.goBack')} onClick={onMenu}><Icon name="arrow-left-s" className="size-6" /></button>
      <h1 className="text-sm font-semibold">{t('folio.settings')}</h1>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-[max(env(safe-area-inset-bottom),1rem)]">
      {message && <div role="status" className="mb-4 rounded-lg bg-secondary px-3 py-2 text-sm">{message}</div>}
      <SyncSection engine={engine} />
      <AppearanceSection onThemeChanged={() => { void syncNow(engine); }} />
      <section className={section}>
        <h2 className="mb-1 font-semibold">{t('folio.aiKeys')}</h2>
        <p className="mb-3 text-xs text-muted-foreground">{t('folio.aiKeysHint')}</p>
        {chatProviders.map((p) => <KeyField key={p.id} provider={p.id} name={p.name} hint={p.keyHint} />)}
      </section>
      <BalanceSection />
      <section className={section}>
        <h2 className="mb-1 font-semibold">{t('folio.moreModels')}</h2>
        <p className="mb-3 text-xs text-muted-foreground">{t('folio.moreModelsHint')}</p>
        <div className="mb-2 flex gap-2">
          <select className="flex-1 rounded-lg border border-border bg-background px-2 py-2 text-sm" aria-label={t('folio.provider')} value={provider} onChange={(e) => { const next = chatProviders.find((p) => p.id === e.target.value); if (next) setProvider(next.id); setFound([]); }}>
            {chatProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button type="button" className="rounded-lg bg-secondary px-3 text-sm disabled:opacity-50" disabled={busy} onClick={() => void loadModels()}>{busy ? '…' : t('folio.findModels')}</button>
        </div>
        {found.length > 0 && <>
          <input className="mb-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-[16px]" placeholder={t('folio.iconFilter')} aria-label={t('folio.iconFilter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="max-h-64 overflow-y-auto">{shown.map((m) => <button key={m.id} type="button" className="flex w-full items-center justify-between gap-2 border-b border-border/40 px-1 py-2 text-left text-sm" onClick={() => { addModels([m]); setMessage(t('folio.modelAdded', { name: m.name })); }}>
            <span className="min-w-0 truncate">{m.name}</span><Icon name="add" className="size-4 shrink-0 text-muted-foreground" />
          </button>)}</div>
        </>}
      </section>
      <section className={section}>
        <h2 className="mb-1 font-semibold">{t('folio.backup')}</h2>
        <p className="mb-3 text-xs text-muted-foreground">{t('folio.backupHint')}</p>
        <div className="flex gap-2">
          <button type="button" className="flex-1 rounded-lg bg-secondary px-3 py-2 text-sm" onClick={() => fileRef.current?.click()}>{t('folio.importBackup')}</button>
          <button type="button" className="flex-1 rounded-lg bg-secondary px-3 py-2 text-sm" onClick={onExportBackup}>{t('folio.exportBackup')}</button>
        </div>
        <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => { void importBackup(e.target.files?.[0]); e.target.value = ''; }} />
      </section>
    </div>
  </div>;
}

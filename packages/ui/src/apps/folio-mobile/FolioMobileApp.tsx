import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { FolioIcon } from '@/components/folio/FolioIcon';
import { FolioSidebar } from '@/components/folio/FolioSidebar';
import { FolioWorkspace, type FolioMobileHooks } from '@/components/folio/FolioWorkspace';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { createIndexedDBStorage, createLocalFolioEngine } from '@/lib/folio/local-engine';
import { findHit } from '@/lib/folio/search';
import { useFolioStore } from '@/lib/folio/store';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { App as CapacitorApp } from '@capacitor/app';
import { isCapacitorApp } from '@/lib/platform';
import { useMobileChatStore } from './chatStore';
import { useSyncStore } from './sync';
import { createPhoneHost } from './host';
import { FolioMobileChat } from './FolioMobileChat';
import { FolioMobileSettings } from './FolioMobileSettings';
import './folio-mobile.css';

type View = 'notes' | 'chat' | 'settings';

function Drawer({ onClose, onView, view }: { onClose: () => void; onView: (view: View) => void; view: View }) {
  const macChats = useSyncStore((s) => s.macChats);
  const { t } = useI18n();
  const notes = useFolioStore((s) => s.status?.notes);
  const { chats, activeID, open } = useMobileChatStore();
  const [query, setQuery] = React.useState('');
  const trimmed = query.trim();
  const results = React.useMemo(() => trimmed
    ? rankByQuery((notes ?? []).filter((n) => !n.trashed), trimmed, (n) => [n.title, ...n.tags, n.blocks.map((b) => b.text).join(' ')]).slice(0, 8).map((note) => ({ note, hit: findHit(note, trimmed) }))
    : [], [notes, trimmed]);
  const row = 'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[15px] active:bg-interactive-selection';

  return <div className="fixed inset-0 z-50 flex" role="dialog" aria-label={t('folio.menu')}>
    <div className="flex h-full w-[86%] max-w-sm flex-col border-r border-border bg-background pt-[env(safe-area-inset-top)] shadow-2xl">
      <div className="px-3 pb-2 pt-3">
        <div className="flex h-10 items-center gap-2 rounded-xl bg-secondary px-3">
          <Icon name="search" className="size-4 shrink-0 text-muted-foreground" />
          <input className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-muted-foreground" placeholder={t('folio.searchOrAsk')} aria-label={t('folio.searchOrAsk')} value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && <button type="button" aria-label={t('folio.remove')} onClick={() => setQuery('')}><Icon name="close" className="size-4 text-muted-foreground" /></button>}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-[max(env(safe-area-inset-bottom),1rem)]">
        {trimmed ? <>
          <button type="button" className={row} onClick={() => { open(undefined); onView('chat'); useMobileChatStore.setState({ pendingPrompt: trimmed }); }}>
            <Icon name="sparkling" className="size-4 shrink-0 text-primary" /><span className="truncate">{t('folio.ask')}: “{trimmed}”</span>
          </button>
          {results.map(({ note, hit }) => <button key={note.id} type="button" className={cn(row, 'items-start')} onClick={() => {
            useFolioStore.getState().setFound(hit ? { noteID: note.id, blockID: hit.blockID, query: hit.match } : undefined);
            void useFolioStore.getState().run({ command: 'select', noteID: note.id }); onView('notes');
          }}>
            <span className="mt-0.5 shrink-0"><FolioIcon value={note.icon} /></span>
            <span className="min-w-0 flex-1"><span className="block truncate">{note.title || t('folio.untitled')}</span>
              {hit && <span className="line-clamp-2 text-xs text-muted-foreground">{hit.before}<mark className="rounded-sm bg-[color-mix(in_srgb,var(--status-warning)_35%,transparent)] px-0.5 text-foreground">{hit.match}</mark>{hit.after}</span>}</span>
          </button>)}
          {results.length === 0 && <div className="px-3 py-2 text-sm text-muted-foreground">{t('folio.noMatches')}</div>}
        </> : <>
          <button type="button" className={cn(row, view === 'chat' && !activeID && 'bg-interactive-selection')} onClick={() => { open(undefined); onView('chat'); }}><Icon name="chat-new" className="size-4 text-muted-foreground" />{t('folio.newChat')}</button>
          <button type="button" className={cn(row, view === 'settings' && 'bg-interactive-selection')} onClick={() => onView('settings')}><Icon name="settings-3" className="size-4 text-muted-foreground" />{t('folio.settings')}</button>
          {chats.length > 0 && <>
            <div className="px-2.5 pb-1 pt-4 text-xs font-medium text-muted-foreground">{t('folio.chats')}</div>
            {chats.slice(0, 8).map((chat) => <button key={chat.id} type="button" className={cn(row, 'py-1.5 text-sm', view === 'chat' && activeID === chat.id && 'bg-interactive-selection')} onClick={() => { open(chat.id); onView('chat'); }}>
              <Icon name="chat-3" className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">{chat.title || t('folio.newChat')}</span>
            </button>)}
          </>}
          {macChats.length > 0 && <>
            <div className="px-2.5 pb-1 pt-4 text-xs font-medium text-muted-foreground">{t('folio.macChats')}</div>
            {macChats.slice(0, 12).map((chat) => <button key={chat.id} type="button" className={cn(row, 'py-1.5 text-sm')} onClick={() => { useMobileChatStore.getState().open(undefined); void useSyncStore.getState().loadMacChat(chat); onView('chat'); }}>
              <Icon name="computer" className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">{chat.title}</span>
            </button>)}
          </>}
          <div className="folio-mobile-tree"><FolioSidebar /></div>
        </>}
      </div>
    </div>
    <button type="button" className="flex-1 bg-black/40" aria-label={t('folio.close')} onClick={onClose} />
  </div>;
}

/** The standalone iPhone app: notes stored on the phone, chat straight to AI providers. */
export function FolioMobileApp() {
  const { t } = useI18n();
  const [view, setView] = React.useState<View>('notes');
  const [drawer, setDrawer] = React.useState(false);
  const viewRef = React.useRef(setView);
  const [sheetFile, setSheetFile] = React.useState<File>();
  const host = React.useMemo(() => createPhoneHost((kind) => {
    if (kind === 'settings') { viewRef.current('settings'); return true; }
    if (kind === 'assistant') { viewRef.current('chat'); return true; }
    return false;
  }, setSheetFile), []);
  const engine = React.useMemo(() => createLocalFolioEngine({
    storage: createIndexedDBStorage(),
    host,
    onChange: () => { void useFolioStore.getState().refresh(); },
  }), [host]);

  React.useEffect(() => {
    useFolioStore.getState().bind(engine);
    void engine.ready.then(() => { useFolioStore.setState({ open: true }); return useFolioStore.getState().refresh(); });
    void useMobileChatStore.getState().load();
    const sync = useSyncStore.getState();
    sync.load();
    void engine.ready.then(() => useSyncStore.getState().syncNow(engine));
    // Pairing links arrive from the Camera app scanning the Mac's code.
    const pairFrom = (url: string | undefined) => { if (url?.startsWith('folio-sync:')) void useSyncStore.getState().pair(url, engine).then((ok) => { if (ok) setView('settings'); }); };
    let urlListener: { remove: () => Promise<void> } | undefined;
    if (isCapacitorApp()) {
      void CapacitorApp.getLaunchUrl().then((launch) => pairFrom(launch?.url)).catch(() => undefined);
      void CapacitorApp.addListener('appUrlOpen', ({ url }) => pairFrom(url)).then((handle) => { urlListener = handle; });
    }
    const every = setInterval(() => { if (document.visibilityState === 'visible') void useSyncStore.getState().syncNow(engine); }, 120_000);
    // Save any open edit when the app goes to the background.
    const hide = () => {
      if (document.visibilityState === 'hidden') void useFolioStore.getState().flush().catch(() => undefined);
      else void useSyncStore.getState().syncNow(engine);
    };
    document.addEventListener('visibilitychange', hide);
    return () => { document.removeEventListener('visibilitychange', hide); clearInterval(every); void urlListener?.remove(); };
  }, [engine]);

  // Opening a page from the menu (tree, search, create) closes the menu and shows it.
  const selectedID = useFolioStore((s) => s.status?.selectedID);
  const home = useFolioStore((s) => s.home);
  const lastSelection = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    const key = `${selectedID}:${home}`;
    if (lastSelection.current !== undefined && lastSelection.current !== key) { setView('notes'); setDrawer(false); }
    lastSelection.current = key;
  }, [selectedID, home]);

  // Sync a few seconds after edits or new chat replies settle.
  const notes = useFolioStore((s) => s.status?.notes);
  const chats = useMobileChatStore((s) => s.chats);
  const firstRun = React.useRef(true);
  React.useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const timer = setTimeout(() => void useSyncStore.getState().syncNow(engine), 8000);
    return () => clearTimeout(timer);
  }, [notes, chats, engine]);

  const show = (next: View) => { setView(next); setDrawer(false); };
  const menu = () => setDrawer(true);
  const mobile = React.useMemo((): FolioMobileHooks => ({
    onAttach: (noteID) => { void host.pickFiles('*/*', true).then((files) => engine.attachFiles(noteID, files)); },
    onImport: () => { void host.pickFiles('.json,.md,.markdown,.txt,application/json,text/markdown,text/plain', true).then((files) => engine.importFiles(files)); },
    onExport: (note, kind) => { const file = engine.exportFile(note, kind); if (file) void host.share(file); },
    onExportLibrary: () => { void host.share(engine.backupFile()); },
    onMenu: () => setDrawer(true),
    onAddToChat: (_markdown: string, noteID: string) => {
      useMobileChatStore.getState().open(undefined);
      useMobileChatStore.setState({ pendingNoteID: noteID });
      setView('chat');
    },
  }), [engine, host]);

  return <div className="folio-mobile flex h-full flex-col bg-background pt-[env(safe-area-inset-top)]">
    <div className="min-h-0 flex-1">
      {view === 'notes' && <FolioWorkspace mobile={mobile} />}
      {view === 'chat' && <FolioMobileChat onMenu={menu} />}
      {view === 'settings' && <FolioMobileSettings engine={engine} onMenu={menu} onExportBackup={() => { void host.share(engine.backupFile()); }} />}
    </div>
    {drawer && <Drawer view={view} onView={show} onClose={() => setDrawer(false)} />}
    {sheetFile && <div className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background px-4 pb-[max(env(safe-area-inset-bottom),1rem)] pt-3 shadow-2xl" role="dialog" aria-label={sheetFile.name}>
      <div className="mb-3 flex items-center gap-2 text-sm"><Icon name="attachment-2" className="size-4 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{sheetFile.name}</span></div>
      <div className="flex gap-2">
        <button type="button" className="flex-1 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground" onClick={() => { void host.share(sheetFile); setSheetFile(undefined); }}>{t('folio.openOrShare')}</button>
        <button type="button" className="rounded-lg bg-secondary px-3 py-2 text-sm" onClick={() => setSheetFile(undefined)}>{t('folio.close')}</button>
      </div>
    </div>}
  </div>;
}

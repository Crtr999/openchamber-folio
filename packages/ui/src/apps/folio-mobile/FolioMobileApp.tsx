import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { FolioWorkspace, type FolioMobileHooks } from '@/components/folio/FolioWorkspace';
import { setFolioAssetReader } from '@/lib/folio/assets';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { createIndexedDBStorage, createLocalFolioEngine } from '@/lib/folio/local-engine';
import { useFolioStore } from '@/lib/folio/store';
import { App as CapacitorApp } from '@capacitor/app';
import { isCapacitorApp } from '@/lib/platform';
import { Keyboard, KeyboardResize } from '@capacitor/keyboard';
import { FOLIO_CHATS_OFFSTAGE_CLASS } from '../mobileNativeChrome';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import type { RuntimeAPIs } from '@/lib/api/types';
import { MobileApp } from '../MobileApp';
import { FolioShellContext, type FolioShell } from '../folioShell';
import { Toaster } from '@/components/ui/sonner';
import { toast } from '@/components/ui';
import { markdownToNote, noteToMarkdown } from '@/lib/folio/local-engine';
import { sendChat } from '@/lib/folio/mobile-chat';
import { makeBlock } from '@/lib/folio/schema';
import { readKey, useMobileChatStore } from './chatStore';
import { askForChatsLink, hasLocalChanges, macAsset, macBella, useSyncStore } from './sync';
import { createPhoneHost, nativeEditor, nativeNotifications, nativePost } from './host';
import { noteSchema } from '@/lib/folio/schema';
import { FolioMobileChat } from './FolioMobileChat';
import { FolioMobileSettings } from './FolioMobileSettings';
import { MobileAssistantList, MobileCalendar, MobileHome, MobileSearch, type MobileView } from './FolioMobileHome';
import { useBalanceStore } from './balance';
import { SwipeBackPane } from './SwipeBack';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import './folio-mobile.css';

/** The chats UI does not re-render when the notes around it change (typing in its forms stays smooth). */
const StableMobileApp = React.memo(MobileApp);

/** Where "back" goes from a chat: the conversation list if it was opened from there, otherwise home. */
type ChatOrigin = 'home' | 'assistant';

/**
 * The standalone iPhone app. Notes live on the phone and sync with the Mac. Chats are the Mac's own
 * OpenChamber chats (same projects, sessions, agents and tools), reached over Wi-Fi or the private
 * relay; when the Mac can't be reached, an offline chat talks to AI providers straight from the phone.
 */
export function FolioMobileApp({ apis }: { apis: RuntimeAPIs }) {
  const { t } = useI18n();
  const [view, setView] = React.useState<MobileView>(() => {
    try { const last = localStorage.getItem('folio.lastView'); return last === 'notes' || last === 'chat' ? last : 'home'; } catch { return 'home'; }
  });
  const [chatOrigin, setChatOrigin] = React.useState<ChatOrigin>('home');
  // The chat UI mounts on first use and then stays mounted, so its connection and scroll position survive switching.
  const [chatsMounted, setChatsMounted] = React.useState(false);
  const [connectLink, setConnectLink] = React.useState<string>();
  React.useEffect(() => { if (view === 'chats') setChatsMounted(true); }, [view]);
  // Connect the chats shortly after launch too, so the Mac connection (and sync over it) is ready.
  React.useEffect(() => { const timer = setTimeout(() => setChatsMounted(true), 1500); return () => clearTimeout(timer); }, []);
  const viewRef = React.useRef(setView);
  const [sheetFile, setSheetFile] = React.useState<File>();
  const host = React.useMemo(() => createPhoneHost({
    openScreen: (kind) => {
      if (kind === 'settings') { viewRef.current('settings'); return true; }
      if (kind === 'assistant') { viewRef.current('assistant'); return true; }
      if (kind === 'calendar') { viewRef.current('calendar'); return true; }
      return false;
    },
    showFile: setSheetFile,
    bella: macBella,
    downloadAsset: macAsset,
  }), []);
  const engine = React.useMemo(() => createLocalFolioEngine({
    storage: createIndexedDBStorage(),
    host,
    onChange: () => { void useFolioStore.getState().refresh(); },
  }), [host]);

  React.useEffect(() => {
    useFolioStore.getState().bind(engine);
    setFolioAssetReader((asset) => engine.readAsset(asset));
    void engine.ready.then(() => { useFolioStore.setState({ open: true }); return useFolioStore.getState().refresh(); });
    void useMobileChatStore.getState().load();
    const sync = useSyncStore.getState();
    sync.load();
    void engine.ready.then(() => useSyncStore.getState().syncNow(engine));
    // Once the calendar is shown, keep it fresh on launch and every return to the app.
    const calendarOn = () => { try { return localStorage.getItem('folio.calendar') === '1'; } catch { return false; } };
    const refreshCalendar = () => { if (calendarOn()) void engine.request({ command: 'calendar-connect' }).then(() => useFolioStore.getState().refresh()); };
    void engine.ready.then(refreshCalendar);
    // Pairing links arrive from the Camera app scanning the Mac's code.
    const pairFrom = (url: string | undefined) => {
      if (url?.startsWith('folio-sync:')) void useSyncStore.getState().pair(url, engine).then((ok) => { if (ok) setView('settings'); });
      // OpenChamber "Add a device" codes scanned with the Camera app connect the chats.
      if (url && /^openchamber:\/\/connect/i.test(url)) { setConnectLink(url); setView('chats'); }
    };
    let urlListener: { remove: () => Promise<void> } | undefined;
    let reminderListener: { remove: () => Promise<void> } | undefined;
    if (isCapacitorApp()) {
      // Tapping a meeting reminder opens meeting notes for that call.
      void nativeNotifications.addListener('opened', ({ eventID }) => {
        void engine.ready
          .then(() => engine.request({ command: 'calendar-connect' }))
          .then(() => engine.request({ command: 'calendar-prepare', eventID }))
          .then(() => { setView('notes'); return useFolioStore.getState().refresh(); });
      }).then((handle) => { reminderListener = handle; });
      void CapacitorApp.getLaunchUrl().then((launch) => pairFrom(launch?.url)).catch(() => undefined);
      void CapacitorApp.addListener('appUrlOpen', ({ url }) => pairFrom(url)).then((handle) => { urlListener = handle; });
    }
    // Sync as soon as the chats connect to the Mac (possibly over the relay, away from home).
    const unsubscribeRuntime = subscribeRuntimeEndpointChanged(() => { setTimeout(() => void useSyncStore.getState().syncNow(engine), 1500); });
    const every = setInterval(() => { if (document.visibilityState === 'visible') void useSyncStore.getState().syncNow(engine); }, 120_000);
    // Save any open edit when the app goes to the background.
    const hide = () => {
      if (document.visibilityState === 'hidden') void useFolioStore.getState().flush().catch(() => undefined);
      else { void useSyncStore.getState().syncNow(engine); refreshCalendar(); }
    };
    document.addEventListener('visibilitychange', hide);
    return () => { document.removeEventListener('visibilitychange', hide); clearInterval(every); unsubscribeRuntime(); void urlListener?.remove(); void reminderListener?.remove(); };
  }, [engine]);

  // A page opened from anywhere else (a new page, an @ link, a meeting note, a chat citation) is shown.
  // The first selection after launch is only the restored page, so the app still opens on Home.
  const selectedID = useFolioStore((s) => s.status?.selectedID);
  const lastSelection = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    if (lastSelection.current !== undefined && selectedID && lastSelection.current !== selectedID) setView('notes');
    lastSelection.current = selectedID;
  }, [selectedID]);
  const openNote = (id: string) => { void useFolioStore.getState().run({ command: 'select', noteID: id }); setView('notes'); };

  // The Mac sent a one-time chats link over the paired sync: connect the chats in the background.
  const macConnectLink = useSyncStore((s) => s.connectLink);
  React.useEffect(() => {
    if (!macConnectLink) return;
    setChatsMounted(true);
    setConnectLink(macConnectLink);
    useSyncStore.setState({ connectLink: undefined });
  }, [macConnectLink]);

  // Reopen where the app was left: the same page or conversation.
  React.useEffect(() => { try { localStorage.setItem('folio.lastView', view); } catch { /* storage blocked */ } }, [view]);
  const calendarConnected = useFolioStore((s) => s.status?.calendarConnected);
  React.useEffect(() => { if (calendarConnected) { try { localStorage.setItem('folio.calendar', '1'); } catch { /* storage blocked */ } } }, [calendarConnected]);


  // The chats stay mounted behind the notes. Only while they are on screen does the keyboard overlay
  // the web view (their layout lifts itself); every other screen lets iOS shrink the web view, so the
  // caret stays visible without any extra bar or offset.
  const [sessionsRequest, setSessionsRequest] = React.useState(0);
  React.useEffect(() => {
    const onChats = view === 'chats';
    document.documentElement.classList.toggle(FOLIO_CHATS_OFFSTAGE_CLASS, !onChats);
    if (isCapacitorApp()) void Keyboard.setResizeMode({ mode: onChats ? KeyboardResize.None : KeyboardResize.Native }).catch(() => undefined);
  }, [view]);
  // Home stays drawn under every other screen only while a swipe back is revealing it.
  const [peek, setPeek] = React.useState(false);
  React.useEffect(() => { if (view === 'home') setPeek(false); }, [view]);

  const shell = React.useMemo((): FolioShell => ({
    onOpenNotes: () => setView('home'),
    sessionsRequest,
    onOfflineChat: () => { useMobileChatStore.getState().open(undefined); setChatOrigin('home'); setView('chat'); },
    pendingConnectLink: connectLink,
    consumeConnectLink: () => setConnectLink(undefined),
    requestConnectLink: () => { void askForChatsLink(); },
  }), [connectLink, sessionsRequest]);
  const goHome = () => setView('home');
  const openChat = (id: string | undefined, origin: ChatOrigin) => { useMobileChatStore.getState().open(id); setChatOrigin(origin); setView('chat'); };
  const newPage = () => { void useFolioStore.getState().run({ command: 'create', kind: 'note' }); };
  // The OpenRouter balance shows in the assistant; refresh it on launch and every ten minutes.
  React.useEffect(() => { void useBalanceStore.getState().refresh(); const timer = setInterval(() => void useBalanceStore.getState().refresh(), 600_000); return () => clearInterval(timer); }, []);
  const mobile = React.useMemo((): FolioMobileHooks => ({
    onAttach: (noteID) => { void host.pickFiles('*/*', true).then((files) => engine.attachFiles(noteID, files)); },
    onImport: () => { void host.pickFiles('.json,.md,.markdown,.txt,application/json,text/markdown,text/plain', true).then((files) => engine.importFiles(files)); },
    onExport: (note, kind) => { const file = engine.exportFile(note, kind); if (file) void host.share(file); },
    onExportLibrary: () => { void host.share(engine.backupFile()); },
    onSummarize: (note, done) => {
      void (async () => {
        const model = useMobileChatStore.getState().model;
        const pending = toast.loading(t('folio.summarizing'));
        let summary = '';
        try {
          await sendChat({
            model, key: await readKey(model.provider), signal: new AbortController().signal, nativePost,
            messages: [
              { role: 'system', content: 'Summarize this page for its owner. Use short markdown: a few bullet points of what matters, then "## Decisions", then "## Action items" as "- [ ] " tasks with owners when known. Do not invent facts.' },
              { role: 'user', content: noteToMarkdown(note) },
            ],
            onText: (piece) => { summary += piece; },
          });
          const latest = useFolioStore.getState().drafts[note.id]?.note ?? useFolioStore.getState().status?.notes.find((n) => n.id === note.id);
          if (latest && summary.trim()) {
            const parsed = markdownToNote(summary, '', Date.now()).blocks;
            useFolioStore.getState().edit({ ...latest, blocks: [...latest.blocks, { ...makeBlock(), kind: 'heading2', text: t('folio.summary') }, ...parsed] });
          }
          toast.success(t('folio.summaryAdded'), { id: pending });
          done?.();
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error), { id: pending });
        }
      })();
    },
    onMenu: () => setView('home'),
    onAddToChat: (_markdown: string, noteID: string) => {
      useMobileChatStore.getState().open(undefined);
      useMobileChatStore.setState({ pendingNoteID: noteID });
      setChatOrigin('home'); setView('chat');
    },
  }), [engine, host, t]);

  // Ask AI is a new chat on the Mac (your models and tools, no key on the phone) whenever the Mac is
  // reachable; the phone's own assistant is the fallback for when it is not.
  const askAI = () => {
    if (useProjectsStore.getState().projects.length > 0) {
      useSessionUIStore.getState().openNewSessionDraft({ target: 'chat', directoryOverride: null });
      setView('chats');
    } else openChat(undefined, 'home');
  };
  // ---- Pages open in the native iPhone editor (FolioNoteEditor.swift); databases, and pages the user
  // asked to see in the classic editor, stay in the web editor.
  const [classicFor, setClassicFor] = React.useState<string>();
  const [nativeEpoch, setNativeEpoch] = React.useState(0);
  const mobileRef = React.useRef(mobile); mobileRef.current = mobile;
  const nativeFor = React.useRef<string | undefined>(undefined);
  const afterClose = React.useRef<MobileView>('home');
  const viewNow = React.useRef(view); viewNow.current = view;
  const tNow = React.useRef(t); tNow.current = t;
  const selectedNote = useFolioStore((s) => s.status?.notes.find((n) => n.id === s.status?.selectedID));
  const useNative = isCapacitorApp() && view === 'notes' && Boolean(selectedNote) && !selectedNote?.table && classicFor !== selectedNote?.id;
  React.useEffect(() => {
    if (!useNative || !selectedNote || nativeFor.current === selectedNote.id) return;
    nativeFor.current = selectedNote.id;
    const state = useFolioStore.getState();
    const latest = state.drafts[selectedNote.id]?.note ?? selectedNote;
    const titles: Record<string, string> = {};
    for (const n of state.status?.notes ?? []) titles[n.id] = n.title || t('folio.untitled');
    void nativeEditor.open({ note: latest, titles }).catch(() => { nativeFor.current = undefined; setClassicFor(selectedNote.id); });
  }, [useNative, selectedNote, t, nativeEpoch]);
  const closeNative = React.useCallback((next: MobileView) => { afterClose.current = next; void nativeEditor.close(); }, []);
  React.useEffect(() => {
    if (!isCapacitorApp()) return;
    const handles: Array<Promise<{ remove: () => Promise<void> }>> = [
      nativeEditor.addListener('change', ({ note }) => {
        const parsed = noteSchema.safeParse(note);
        if (parsed.success) useFolioStore.getState().edit(parsed.data);
      }),
      nativeEditor.addListener('closed', () => {
        nativeFor.current = undefined;
        void useFolioStore.getState().flush().catch(() => undefined);
        const next = afterClose.current; afterClose.current = 'home';
        if (viewNow.current === 'notes') setView(next);
      }),
      nativeEditor.addListener('openNote', ({ noteID }) => {
        const store = useFolioStore.getState();
        if (!store.status?.notes.some((n) => n.id === noteID)) {
          // The native editor sits on top of the web view, so the toast only reaches the user once it steps aside.
          toast.error(tNow.current('folio.db.missing'));
          closeNative('home');
          return;
        }
        void store.run({ command: 'select', noteID });
      }),
      nativeEditor.addListener('action', ({ kind, noteID }) => {
        const store = useFolioStore.getState();
        const note = store.drafts[noteID]?.note ?? store.status?.notes.find((n) => n.id === noteID);
        if (!note) return;
        if (kind === 'ask') { closeNative('chat'); mobileRef.current.onAddToChat('', noteID); }
        else if (kind === 'summarize') mobileRef.current.onSummarize(note, () => { nativeFor.current = undefined; setNativeEpoch((n) => n + 1); });
        else if (kind === 'read') void store.run({ command: 'read', noteID });
        else if (kind === 'share') mobileRef.current.onExport(note, 'md');
        else if (kind === 'trash') { closeNative('home'); void store.flush().then(() => store.run({ command: 'trash', noteID })); }
        else if (kind === 'classic') { setClassicFor(noteID); closeNative('notes'); }
      }),
    ];
    return () => { for (const handle of handles) void handle.then((h) => h.remove()); };
  }, [closeNative]);
  // The classic editor is a one-time choice for that visit to the page.
  React.useEffect(() => { if (view !== 'notes') setClassicFor(undefined); }, [view]);
  // Leaving the page by any other route (a notification, a pairing link) closes the native editor too,
  // and so does a page that turns out to belong in the classic editor: the native one covers the web view
  // it mounts in, so without this the tap that selected a database would leave the user where they were.
  React.useEffect(() => { if (nativeFor.current && (view !== 'notes' || !useNative)) { afterClose.current = view; void nativeEditor.close(); } }, [view, useNative]);

  // In the classic editor, a button switches back to the native one.
  const classicActive = Boolean(classicFor && classicFor === selectedNote?.id);
  const classicMobile = React.useMemo((): FolioMobileHooks => (classicActive ? { ...mobile, onNativeEditor: () => setClassicFor(undefined) } : mobile), [classicActive, mobile]);
  const pane = (content: React.ReactNode) => <SwipeBackPane onBack={goHome} onPeek={setPeek}>{content}</SwipeBackPane>;

  return <div className="folio-mobile flex h-full flex-col bg-background pt-[env(safe-area-inset-top)]">
    <SyncScheduler engine={engine} />
    {chatsMounted && <div className={cn('fixed inset-0 z-40', view !== 'chats' && 'hidden')}>
      <SwipeBackPane onBack={goHome} onPeek={setPeek}>
        <FolioShellContext.Provider value={shell}><StableMobileApp apis={apis} /></FolioShellContext.Provider>
      </SwipeBackPane>
    </div>}
    <div className="relative min-h-0 flex-1 overflow-hidden">
      {/* Home is the root of every screen. Covered, it stops re-rendering (typing in a page never redraws it). */}
      <React.Activity mode={view === 'home' || peek || useNative ? 'visible' : 'hidden'}>
        <MobileHome onView={setView} onOpenNote={openNote} onNewPage={newPage} onAsk={askAI}
          onOpenSessions={() => { setView('chats'); setSessionsRequest((n) => n + 1); }} />
      </React.Activity>
      {view === 'notes' && !useNative && pane(<FolioWorkspace mobile={classicMobile} />)}
      {view === 'search' && pane(<MobileSearch onBack={goHome} onOpenNote={openNote} onAsk={(prompt) => { useMobileChatStore.setState({ pendingPrompt: prompt }); openChat(undefined, 'home'); }} />)}
      {view === 'calendar' && pane(<MobileCalendar onBack={goHome} onOpened={() => setView('notes')} />)}
      {view === 'assistant' && pane(<MobileAssistantList onBack={goHome} onOpen={(id) => openChat(id, 'assistant')} />)}
      {view === 'chat' && pane(<FolioMobileChat onMenu={() => setView(chatOrigin)} engine={engine} />)}
      {view === 'settings' && pane(<FolioMobileSettings engine={engine} onMenu={goHome} onExportBackup={() => { void host.share(engine.backupFile()); }} />)}
    </div>
    {view !== 'chats' && <Toaster position="top-center" offset="calc(env(safe-area-inset-top) + 16px)" />}
    {sheetFile && <div className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background px-4 pb-[max(env(safe-area-inset-bottom),1rem)] pt-3 shadow-2xl" role="dialog" aria-label={sheetFile.name}>
      <div className="mb-3 flex items-center gap-2 text-sm"><Icon name="attachment-2" className="size-4 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{sheetFile.name}</span></div>
      <div className="flex gap-2">
        <button type="button" className="flex-1 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground" onClick={() => { void host.share(sheetFile); setSheetFile(undefined); }}>{t('folio.openOrShare')}</button>
        <button type="button" className="rounded-lg bg-secondary px-3 py-2 text-sm" onClick={() => setSheetFile(undefined)}>{t('folio.close')}</button>
      </div>
    </div>}
  </div>;
}

/** Syncs a few seconds after edits or new chat replies settle. Its own component, so a save never redraws the app around it. */
function SyncScheduler({ engine }: { engine: ReturnType<typeof createLocalFolioEngine> }) {
  const notes = useFolioStore((s) => s.status?.notes);
  const chats = useMobileChatStore((s) => s.chats);
  const firstRun = React.useRef(true);
  React.useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    // Only real edits schedule a sync; the refresh after a sync must not schedule another one.
    if (!hasLocalChanges(engine)) return;
    const timer = setTimeout(() => void useSyncStore.getState().syncNow(engine), 8000);
    return () => clearTimeout(timer);
  }, [notes, chats, engine]);
  return null;
}

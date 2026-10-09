import React from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { createChatSearchCache, searchChats, type ChatSearchMatch } from '@/lib/opencode/chat-search';
import type { Session } from '@/lib/opencode/model';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionTabsStore } from '@/stores/useSessionTabsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { NEW_TAB_PALETTE_EVENT, openNewHeaderTab } from '@/lib/sessionTabs';
import { openMeetingWorkspace } from '@/lib/meetings/workspace';
import { ADVANCED_SEARCH_EVENT, SEARCH_PALETTE_EVENT } from '@/lib/searchPalette';

/**
 * Notion-style quick search. One palette serves two doors:
 * - the header's + button ("Open in new tab…"), and
 * - the sidebar search button / shortcut ("Search chats…").
 * Title matches appear instantly; message-content matches stream in below them
 * with highlighted excerpts, and the right pane previews whatever is selected.
 */

type Mode = 'search' | 'newTab';
type Row =
  | { kind: 'action'; id: string; icon: IconName; label: string; hint?: string; run: () => void }
  | { kind: 'session'; id: string; session: Session; group?: string }
  | { kind: 'match'; id: string; match: ChatSearchMatch };

const PREVIEW_KEY = 'open-carter:search-preview';
const readPreviewPref = () => { try { return window.localStorage.getItem(PREVIEW_KEY) !== '0'; } catch { return true; } };
const writePreviewPref = (value: boolean) => { try { window.localStorage.setItem(PREVIEW_KEY, value ? '1' : '0'); } catch { /* convenience only */ } };

// Shared across openings so repeat searches are instant.
let sharedCache = createChatSearchCache();
const previewCache = new Map<string, string[]>();

const DAY = 86_400_000;
const startOfDay = (time: number) => { const date = new Date(time); date.setHours(0, 0, 0, 0); return date.getTime(); };

function relativeTime(time: number, locale: string) {
  const diff = time - Date.now();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60_000) return rtf.format(0, 'second');
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < DAY) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  if (abs < 30 * DAY) return rtf.format(Math.round(diff / DAY), 'day');
  return new Date(time).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

function Highlight({ text, query }: { text: string; query: string }) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter((term) => term.length > 0);
  if (!terms.length) return <>{text}</>;
  const lower = text.toLocaleLowerCase();
  const marks: Array<[number, number]> = [];
  for (const term of terms) {
    let from = 0;
    while (from < lower.length) {
      const index = lower.indexOf(term, from);
      if (index < 0) break;
      marks.push([index, index + term.length]);
      from = index + term.length;
    }
  }
  if (!marks.length) return <>{text}</>;
  marks.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const mark of marks) {
    const last = merged[merged.length - 1];
    if (last && mark[0] <= last[1]) last[1] = Math.max(last[1], mark[1]);
    else merged.push([...mark]);
  }
  const out: React.ReactNode[] = [];
  let cursor = 0;
  merged.forEach(([start, end], index) => {
    if (start > cursor) out.push(text.slice(cursor, start));
    out.push(<span key={index} className="font-semibold text-primary">{text.slice(start, end)}</span>);
    cursor = end;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return <>{out}</>;
}

function SkeletonRows({ count = 5 }: { count?: number }) {
  return <div aria-hidden className="space-y-3 px-3 py-2">
    {Array.from({ length: count }, (_, index) => <div key={index} className="flex items-start gap-3" style={{ animationDelay: `${index * 80}ms` }}>
      <div className="oc-shimmer mt-0.5 size-4 shrink-0 rounded" />
      <div className="flex-1 space-y-1.5">
        <div className="oc-shimmer h-3 rounded" style={{ width: `${45 + ((index * 17) % 35)}%` }} />
        <div className="oc-shimmer h-2.5 rounded" style={{ width: `${25 + ((index * 23) % 30)}%` }} />
      </div>
    </div>)}
  </div>;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="inline-flex min-w-[18px] items-center justify-center rounded border border-border/70 bg-muted/40 px-1 font-sans text-[10.5px] leading-4 text-muted-foreground">{children}</kbd>;
}

export function NotionSearchPalette() {
  const { t, locale } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<Mode>('search');
  const [query, setQuery] = React.useState('');
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [showPreview, setShowPreview] = React.useState(readPreviewPref);
  const [matches, setMatches] = React.useState<ChatSearchMatch[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [searchedQuery, setSearchedQuery] = React.useState('');
  const [preview, setPreview] = React.useState<{ id: string; lines: string[] | null }>({ id: '', lines: null });
  const abortRef = React.useRef<AbortController | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const pointerMovedRef = React.useRef(false);

  const activeSessions = useGlobalSessionsStore((state) => (open ? state.activeSessions : EMPTY));
  const projects = useProjectsStore((state) => state.projects);

  const projectLabel = React.useCallback((directory: string) => {
    let best: { label: string; length: number } | null = null;
    for (const project of projects) {
      if (directory === project.path || directory.startsWith(`${project.path}/`)) {
        if (!best || project.path.length > best.length) best = { label: project.label || project.path.split('/').pop() || project.path, length: project.path.length };
      }
    }
    return best?.label ?? directory.split('/').pop() ?? '';
  }, [projects]);

  // Dismissing the + palette leaves the new, empty tab open (like Notion); its
  // close button abandons it.
  const close = React.useCallback(() => {
    abortRef.current?.abort(); abortRef.current = null;
    setOpen(false); setQuery(''); setMatches([]); setSearching(false); setSearchedQuery('');
  }, []);

  React.useEffect(() => {
    const showSearch = () => { setMode('search'); setOpen(true); setSelectedIndex(0); };
    const showNewTab = () => { setMode('newTab'); setOpen(true); setSelectedIndex(0); };
    window.addEventListener(SEARCH_PALETTE_EVENT, showSearch);
    window.addEventListener('openchamber:sidebar-session-search', showSearch);
    window.addEventListener(NEW_TAB_PALETTE_EVENT, showNewTab);
    // ⌘T opens a new tab, like a browser or Notion.
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 't') return;
      if (useUIStore.getState().isSettingsDialogOpen) return;
      event.preventDefault();
      openNewHeaderTab();
    };
    window.addEventListener('keydown', shortcut);
    const unsubscribe = subscribeRuntimeEndpointChanged(() => { sharedCache = createChatSearchCache(); previewCache.clear(); setOpen(false); });
    return () => {
      window.removeEventListener(SEARCH_PALETTE_EVENT, showSearch);
      window.removeEventListener('openchamber:sidebar-session-search', showSearch);
      window.removeEventListener(NEW_TAB_PALETTE_EVENT, showNewTab);
      window.removeEventListener('keydown', shortcut);
      unsubscribe();
    };
  }, []);

  // Keep typing in the palette: a new-tab draft mounts the composer, which
  // autofocuses a frame later and would otherwise steal the keystrokes.
  React.useEffect(() => {
    if (!open) return;
    const focusInput = () => inputRef.current?.focus();
    requestAnimationFrame(focusInput);
    const timers = [60, 180, 400].map((delay) => window.setTimeout(focusInput, delay));
    const keepFocus = (event: FocusEvent) => {
      if (panelRef.current && event.target instanceof Node && !panelRef.current.contains(event.target)) focusInput();
    };
    document.addEventListener('focusin', keepFocus);
    return () => { timers.forEach((timer) => window.clearTimeout(timer)); document.removeEventListener('focusin', keepFocus); };
  }, [open, mode]);

  React.useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (panelRef.current && event.composedPath().includes(panelRef.current)) return;
      close();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open, close]);

  // Content search: debounced, cancellable, streams results as sessions finish.
  React.useEffect(() => {
    abortRef.current?.abort(); abortRef.current = null;
    const trimmed = query.trim();
    if (!open || trimmed.length < 2) { setMatches([]); setSearching(false); setSearchedQuery(''); return; }
    setSearching(true);
    const timer = window.setTimeout(() => {
      const abort = new AbortController();
      abortRef.current = abort;
      void searchChats({ query: trimmed }, {
        sessions: (cursor) => opencodeClient.listSessionsPage({ global: true, limit: 200, cursor, signal: abort.signal }),
        messages: (session, cursor) => opencodeClient.getSessionMessages(session.id, { limit: 100, cursor, order: 'desc', signal: abort.signal }, session.directory),
      }, abort.signal, (value) => {
        if (abortRef.current !== abort) return;
        React.startTransition(() => { setMatches(value.matches); setSearchedQuery(trimmed); });
      }, sharedCache).catch(() => undefined).finally(() => { if (abortRef.current === abort) setSearching(false); });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  const rows = React.useMemo<Row[]>(() => {
    const trimmed = query.trim().toLocaleLowerCase();
    const sessions = activeSessions.filter((session) => !session.parentID && !session.time.archived);
    const out: Row[] = [];
    const actions: Row[] = [];
    if (mode === 'newTab') {
      actions.push({ kind: 'action', id: 'action:new-chat', icon: 'chat-new', label: t('palette.notion.startChat'), hint: '↵', run: () => { close(); } });
    }
    actions.push({ kind: 'action', id: 'action:meeting', icon: 'mic', label: t('palette.notion.startMeeting'), run: () => { close(); openMeetingWorkspace({ title: '', autoStart: true }); } });
    actions.push({ kind: 'action', id: 'action:meetings', icon: 'file-list-2', label: t('palette.notion.meetingLibrary'), run: () => { close(); openMeetingWorkspace({ title: '' }); } });
    if (mode === 'search') actions.push({ kind: 'action', id: 'action:home', icon: 'home', label: t('home.label'), run: () => { close(); useSessionTabsStore.getState().cancelNewTab(); useUIStore.getState().closeMainSurfaces(); useSessionUIStore.getState().openNewSessionDraft(); } });
    if (!trimmed) {
      out.push(...actions.filter((action) => action.kind === 'action' && action.id !== 'action:meetings'));
      const today = startOfDay(Date.now());
      const sorted = [...sessions].sort((a, b) => b.time.updated - a.time.updated).slice(0, 40);
      for (const session of sorted) {
        const updated = session.time.updated;
        const group = updated >= today ? t('palette.notion.today') : updated >= today - DAY ? t('palette.notion.yesterday') : updated >= today - 7 * DAY ? t('palette.notion.week') : t('palette.notion.older');
        out.push({ kind: 'session', id: session.id, session, group });
      }
      return out;
    }
    const terms = trimmed.split(/\s+/);
    const scored = sessions.flatMap((session) => {
      const title = (session.title || '').toLocaleLowerCase();
      if (!terms.every((term) => title.includes(term))) return [];
      const score = (title.startsWith(trimmed) ? 3 : title.includes(trimmed) ? 2 : 1) + Math.min(1, session.time.updated / Date.now());
      return [{ session, score }];
    }).sort((a, b) => b.score - a.score || b.session.time.updated - a.session.time.updated).slice(0, 12);
    for (const action of actions) {
      if (action.kind === 'action' && terms.every((term) => action.label.toLocaleLowerCase().includes(term))) out.push(action);
    }
    const titleIds = new Set(scored.map((entry) => entry.session.id));
    for (const { session } of scored) out.push({ kind: 'session', id: session.id, session, group: t('palette.notion.bestMatches') });
    const seen = new Set<string>();
    for (const match of matches) {
      if (seen.has(match.sessionId) && seen.size > 30) continue;
      if (titleIds.has(match.sessionId) && seen.has(match.sessionId)) continue;
      seen.add(match.sessionId);
      out.push({ kind: 'match', id: `${match.sessionId}/${match.messageId}`, match });
      if (out.length > 80) break;
    }
    return out;
  }, [activeSessions, close, matches, mode, query, t]);

  React.useEffect(() => { setSelectedIndex((index) => Math.min(index, Math.max(0, rows.length - 1))); }, [rows.length]);
  React.useEffect(() => { setSelectedIndex(0); }, [query, mode]);

  const selected = rows[selectedIndex];

  React.useEffect(() => {
    listRef.current?.querySelector(`[data-palette-index="${selectedIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // Lazily preview the last few messages of the selected chat.
  React.useEffect(() => {
    if (!open || !showPreview || !selected || selected.kind !== 'session') return;
    const session = selected.session;
    const cached = previewCache.get(session.id + session.time.updated);
    if (cached) { setPreview({ id: session.id, lines: cached }); return; }
    setPreview({ id: session.id, lines: null });
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      opencodeClient.getSessionMessages(session.id, { limit: 8, order: 'desc', signal: abort.signal }, session.directory).then((page) => {
        const lines = page.items.flatMap(({ info, parts }) => {
          if (info.role !== 'user' && info.role !== 'assistant') return [];
          const text = parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n').trim();
          return text ? [`${info.role === 'user' ? '›' : ''}${text.slice(0, 600)}`] : [];
        }).reverse();
        previewCache.set(session.id + session.time.updated, lines);
        if (!abort.signal.aborted) setPreview({ id: session.id, lines });
      }).catch(() => { if (!abort.signal.aborted) setPreview({ id: session.id, lines: [] }); });
    }, 90);
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [open, selected, showPreview]);

  const openRow = React.useCallback((row: Row | undefined, inNewTab = false) => {
    if (!row) return;
    if (row.kind === 'action') { row.run(); return; }
    if (inNewTab) useSessionTabsStore.getState().requestNewTab();
    useUIStore.getState().closeMainSurfaces();
    if (row.kind === 'session') {
      close();
      useSessionUIStore.getState().setCurrentSession(row.session.id, resolveGlobalSessionDirectory(row.session));
      return;
    }
    const { match } = row;
    close();
    useSessionUIStore.getState().setCurrentSession(match.sessionId, match.directory);
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#search-message-${match.messageId}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }, [close]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setSelectedIndex((index) => (rows.length ? (index + 1) % rows.length : 0)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setSelectedIndex((index) => (rows.length ? (index - 1 + rows.length) % rows.length : 0)); }
    else if (event.key === 'Enter') { event.preventDefault(); openRow(selected, event.metaKey || event.ctrlKey); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  };

  if (!open) return null;

  const trimmed = query.trim();
  const contentPending = trimmed.length >= 2 && (searching || searchedQuery !== trimmed);
  const contentCount = rows.filter((row) => row.kind === 'match').length;
  let lastGroup: string | undefined;

  const renderPreview = () => {
    if (!selected) return <div className="flex h-full items-center justify-center text-[12.5px] text-muted-foreground">{t('palette.notion.nothingSelected')}</div>;
    if (selected.kind === 'action') {
      return <div className="oc-fade-in space-y-3 p-5">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted/60"><Icon name={selected.icon} className="size-5 text-foreground" /></div>
        <h3 className="text-[17px] font-semibold leading-snug text-foreground">{selected.label}</h3>
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">{selected.id === 'action:meeting' ? t('palette.notion.meetingHint') : selected.id === 'action:meetings' ? t('palette.notion.meetingLibraryHint') : selected.id === 'action:home' ? t('palette.notion.homeHint') : t('palette.notion.chatHint')}</p>
      </div>;
    }
    if (selected.kind === 'match') {
      const { match } = selected;
      return <div key={selected.id} className="oc-fade-in space-y-2 p-5">
        <p className="truncate text-[11px] text-muted-foreground">{projectLabel(match.directory)}</p>
        <h3 className="text-[17px] font-semibold leading-snug text-foreground">{match.title || t('sessions.sidebar.session.untitled')}</h3>
        <p className="text-[11px] text-muted-foreground">{new Date(match.created).toLocaleString(locale)}{match.model ? ` · ${match.model}` : ''}</p>
        <p className="whitespace-pre-wrap break-words pt-1 text-[12.5px] leading-relaxed text-foreground/90"><Highlight text={match.preview.slice(0, 2400)} query={trimmed} /></p>
      </div>;
    }
    const { session } = selected;
    const lines = preview.id === session.id ? preview.lines : null;
    return <div key={selected.id} className="oc-fade-in space-y-2 p-5">
      <p className="truncate text-[11px] text-muted-foreground">{projectLabel(session.directory)}</p>
      <h3 className="text-[17px] font-semibold leading-snug text-foreground"><Highlight text={session.title || t('sessions.sidebar.session.untitled')} query={trimmed} /></h3>
      <p className="text-[11px] text-muted-foreground">{t('palette.notion.edited', { time: relativeTime(session.time.updated, locale) })}</p>
      {lines === null ? <div className="space-y-2 pt-2">{[88, 72, 94, 60, 80].map((width, index) => <div key={index} className="oc-shimmer h-2.5 rounded" style={{ width: `${width}%` }} />)}</div>
        : lines.length === 0 ? <p className="pt-2 text-[12.5px] text-muted-foreground">{t('palette.notion.empty')}</p>
          : <div className="space-y-2.5 pt-2">{lines.map((line, index) => line.startsWith('›')
            ? <p key={index} className="ml-auto w-fit max-w-[92%] whitespace-pre-wrap break-words rounded-lg bg-muted/60 px-2.5 py-1.5 text-[12px] leading-relaxed text-foreground line-clamp-4">{line.slice(1)}</p>
            : <p key={index} className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-foreground/85 line-clamp-6">{line}</p>)}</div>}
    </div>;
  };

  return createPortal(<div className="oc-palette-backdrop app-region-no-drag fixed inset-0 z-[60] flex items-start justify-center bg-black/25 px-4 pt-[9vh]">
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={mode === 'newTab' ? t('palette.notion.newTabPlaceholder') : t('palette.notion.searchPlaceholder')}
      onKeyDown={onKeyDown}
      className={cn('oc-palette flex max-h-[min(640px,80dvh)] w-full flex-col overflow-hidden rounded-xl border border-border/80 bg-[var(--surface-elevated,var(--background))] shadow-[0_24px_80px_-12px_rgba(0,0,0,0.55),0_0_0_1px_rgba(255,255,255,0.03)]', showPreview ? 'max-w-[900px]' : 'max-w-[620px]')}
    >
      <div className="flex items-center gap-2.5 border-b border-border/60 px-4 py-3">
        <Icon name="search" className="size-[18px] shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={mode === 'newTab' ? t('palette.notion.newTabPlaceholder') : t('palette.notion.searchPlaceholder')}
          aria-label={mode === 'newTab' ? t('palette.notion.newTabPlaceholder') : t('palette.notion.searchPlaceholder')}
          className="min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground/70"
          spellCheck={false}
          autoComplete="off"
        />
        {searching ? <Icon name="loader-4" className="size-4 shrink-0 animate-spin text-muted-foreground" /> : null}
        <button
          type="button"
          aria-pressed={showPreview}
          title={t('palette.notion.togglePreview')}
          aria-label={t('palette.notion.togglePreview')}
          onClick={() => { const next = !showPreview; setShowPreview(next); writePreviewPref(next); inputRef.current?.focus(); }}
          className={cn('flex size-7 items-center justify-center rounded-md transition-[background-color,color,transform] hover:bg-interactive-hover active:scale-90', showPreview ? 'text-primary' : 'text-muted-foreground')}
        >
          <Icon name="layout-right" className="size-4" />
        </button>
        <button
          type="button"
          title={t('palette.notion.advanced')}
          aria-label={t('palette.notion.advanced')}
          onClick={() => { close(); window.dispatchEvent(new CustomEvent(ADVANCED_SEARCH_EVENT)); }}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-[background-color,color,transform] hover:bg-interactive-hover hover:text-foreground active:scale-90"
        >
          <Icon name="equalizer-2" className="size-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div ref={listRef} role="listbox" className="min-h-[300px] min-w-0 flex-1 overflow-y-auto py-1.5" onPointerMove={() => { pointerMovedRef.current = true; }}>
          {trimmed && rows.length === 0 && !contentPending ? <div className="px-4 py-10 text-center text-[13px] text-muted-foreground">{t('palette.notion.noResults', { query: trimmed })}</div> : null}
          {rows.map((row, index) => {
            const isSelected = index === selectedIndex;
            let header: React.ReactNode = null;
            const group = row.kind === 'session' ? row.group : row.kind === 'match' ? t('palette.notion.inMessages') : undefined;
            if (group && group !== lastGroup) {
              header = <div className="flex items-center justify-between px-4 pb-1 pt-3 text-[11px] font-medium text-muted-foreground">
                <span>{group}{row.kind === 'match' ? ` (${contentCount}${contentPending ? '+' : ''})` : ''}</span>
              </div>;
            }
            lastGroup = group ?? lastGroup;
            const common = {
              role: 'option' as const,
              'aria-selected': isSelected,
              'data-palette-index': index,
              onMouseMove: () => { if (pointerMovedRef.current && !isSelected) setSelectedIndex(index); },
              onClick: (event: React.MouseEvent) => openRow(row, event.metaKey || event.ctrlKey),
              className: cn('oc-palette-row mx-1.5 flex w-[calc(100%-12px)] cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-1.5 text-left', isSelected && 'bg-interactive-hover'),
            };
            if (row.kind === 'action') return <React.Fragment key={row.id}>{header}<button type="button" {...common}>
              <Icon name={row.icon} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-foreground">{row.label}</span>
              {row.hint && isSelected ? <Kbd>{row.hint}</Kbd> : null}
            </button></React.Fragment>;
            if (row.kind === 'session') return <React.Fragment key={row.id}>{header}<button type="button" {...common}>
              <Icon name="chat-3" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-foreground"><Highlight text={row.session.title || t('sessions.sidebar.session.untitled')} query={trimmed} /></span>
                <span className="block truncate text-[11.5px] text-muted-foreground">{projectLabel(row.session.directory)} · {t('palette.notion.edited', { time: relativeTime(row.session.time.updated, locale) })}</span>
              </span>
              {isSelected ? <Kbd>↵</Kbd> : null}
            </button></React.Fragment>;
            const { match } = row;
            return <React.Fragment key={row.id}>{header}<button type="button" {...common}>
              <Icon name="chat-ai-3" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-foreground"><Highlight text={match.title || t('sessions.sidebar.session.untitled')} query={trimmed} /></span>
                <span className="block truncate text-[11.5px] text-muted-foreground">{projectLabel(match.directory)} · {relativeTime(match.created, locale)}</span>
                <span className="mt-0.5 block text-[12px] leading-snug text-foreground/75 line-clamp-2"><Highlight text={match.excerpt.replace(/\s+/g, ' ').trim()} query={trimmed} /></span>
              </span>
            </button></React.Fragment>;
          })}
          {contentPending ? <>
            {contentCount === 0 ? <div className="px-4 pb-1 pt-3 text-[11px] font-medium text-muted-foreground">{t('palette.notion.inMessages')}</div> : null}
            <SkeletonRows count={contentCount === 0 ? 5 : 2} />
          </> : null}
        </div>
        {showPreview ? <div className="hidden w-[340px] shrink-0 overflow-y-auto border-l border-border/60 bg-muted/[0.12] md:block">{renderPreview()}</div> : null}
      </div>
      <div className="flex items-center gap-4 border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd>{t('palette.notion.navigate')}</span>
        <span className="flex items-center gap-1.5"><Kbd>↵</Kbd>{t('palette.notion.open')}</span>
        <span className="flex items-center gap-1.5"><Kbd>⌘</Kbd><Kbd>↵</Kbd>{t('palette.notion.openNewTab')}</span>
        <span className="ml-auto flex items-center gap-1.5"><Kbd>esc</Kbd>{t('palette.notion.close')}</span>
      </div>
    </div>
  </div>, document.body);
}

const EMPTY: Session[] = [];

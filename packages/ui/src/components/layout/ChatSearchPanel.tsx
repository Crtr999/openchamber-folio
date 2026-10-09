import React from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { createChatSearchCache, searchChats, type ChatSearchProgress } from '@/lib/opencode/chat-search';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

export function ChatSearchPanel({ className, enabled = true }: { className?: string; enabled?: boolean }) {
  const { t } = useI18n();
  const projects = useProjectsStore(state => state.projects);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [directory, setDirectory] = React.useState('all');
  const [after, setAfter] = React.useState('');
  const [before, setBefore] = React.useState('');
  const [model, setModel] = React.useState('');
  const [attachmentsOnly, setAttachmentsOnly] = React.useState(false);
  const [state, setState] = React.useState<ChatSearchProgress>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [cancelled, setCancelled] = React.useState(false);
  const cacheRef = React.useRef(createChatSearchCache());
  const debounceRef = React.useRef<number | undefined>(undefined);
  const abortRef = React.useRef<AbortController | null>(null);
  const panelRef = React.useRef<HTMLElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const stop = React.useCallback(() => { window.clearTimeout(debounceRef.current); debounceRef.current = undefined; abortRef.current?.abort(); abortRef.current = null; setBusy(false); }, []);
  const close = React.useCallback(() => { stop(); setOpen(false); setState(undefined); setSelectedId(null); setError(false); setCancelled(false); cacheRef.current = createChatSearchCache(); }, [stop]);
  React.useEffect(() => {
    if (!enabled) { close(); return; }
    const show = () => setOpen(true);
    window.addEventListener('open-carter:advanced-chat-search', show);
    return () => window.removeEventListener('open-carter:advanced-chat-search', show);
  }, [enabled, close]);
  React.useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const path = event.composedPath();
      if (panelRef.current && path.includes(panelRef.current)) return;
      if (triggerRef.current && path.includes(triggerRef.current)) return;
      // The project picker renders its options in a separate portal.
      if (path.some(node => node instanceof Element && node.hasAttribute('data-chat-search-owned'))) return;
      close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault(); close(); triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape); };
  }, [open, close]);
  React.useEffect(() => subscribeRuntimeEndpointChanged(close), [close]);
  React.useEffect(() => () => { window.clearTimeout(debounceRef.current); abortRef.current?.abort(); abortRef.current = null; }, []);
  const runSearch = React.useCallback(async () => {
    if (query.trim().length < 2 || (after && before && after > before)) return;
    stop();
    const abort = new AbortController();
    abortRef.current = abort;
    setState(undefined); setError(false); setCancelled(false); setBusy(true);
    try {
      await searchChats({ query, directory: directory === 'all' ? undefined : directory, model: model.trim(), attachmentsOnly,
        after: after ? new Date(`${after}T00:00:00`).getTime() : undefined,
        before: before ? new Date(`${before}T00:00:00`).setDate(new Date(`${before}T00:00:00`).getDate() + 1) : undefined }, {
        sessions: cursor => opencodeClient.listSessionsPage({ global: true, limit: 200, cursor, signal: abort.signal }),
        messages: (session, cursor) => opencodeClient.getSessionMessages(session.id, { limit: 100, cursor, order: 'desc', signal: abort.signal }, session.directory),
      }, abort.signal, value => { React.startTransition(() => setState(previous => abortRef.current === abort ? value : previous)); }, cacheRef.current);
    } catch { if (!abort.signal.aborted && abortRef.current === abort) setError(true); }
    finally { if (abortRef.current === abort) setBusy(false); }
  }, [query, directory, after, before, model, attachmentsOnly, stop]);
  React.useEffect(() => {
    stop(); setState(undefined); setSelectedId(null); setError(false); setCancelled(false);
    if (!open || query.trim().length < 2) return;
    const timer = window.setTimeout(() => void runSearch(), 300);
    debounceRef.current = timer;
    return () => { window.clearTimeout(timer); stop(); };
  }, [open, runSearch, query, stop]);
  const selected = state?.matches.find(match => match.messageId === selectedId) ?? state?.matches[0];
  const highlight = (text: string) => {
    const needle = query.trim();
    const index = text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
    if (!needle || index < 0) return text;
    return <>{text.slice(0, index)}<mark className="rounded bg-primary/20 text-foreground">{text.slice(index, index + needle.length)}</mark>{text.slice(index + needle.length)}</>;
  };
  return <>
    <Button ref={triggerRef} variant="ghost" size="xs" disabled={!enabled} className={className} title={t('personalTools.search')} aria-label={t('personalTools.search')} aria-expanded={open} onClick={() => open ? close() : window.dispatchEvent(new CustomEvent('open-carter:search-palette'))}><Icon name="search" className="size-4" /></Button>
    {open && createPortal(<section ref={panelRef} role="region" aria-label={t('personalTools.search')} className="app-region-no-drag fixed left-1/2 top-20 z-50 flex max-h-[calc(100dvh-7rem)] w-[calc(100vw-2rem)] max-w-6xl -translate-x-1/2 flex-col gap-4 rounded-2xl border border-border bg-background p-5 shadow-2xl">
        <div><h2 className="typography-ui-header font-medium">{t('personalTools.search')}</h2><p className="mt-1 text-muted-foreground typography-meta">{t('personalTools.searchHint')}</p></div>
        <form onSubmit={event => { event.preventDefault(); window.clearTimeout(debounceRef.current); void runSearch(); }} className="space-y-3">
          <div className="flex gap-2"><Input autoFocus aria-label={t('personalTools.query')} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('personalTools.query')} /><Button type="submit" size="sm" disabled={busy || query.trim().length < 2 || Boolean(after && before && after > before)}>{t('personalTools.search')}</Button></div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 typography-ui-label">
            <label className="space-y-1"><span>{t('personalTools.project')}</span><Select value={directory} onValueChange={setDirectory}><SelectTrigger className="w-full"><SelectValue>{directory === 'all' ? t('personalTools.all') : projects.find(project => project.path === directory)?.label || directory.split('/').pop()}</SelectValue></SelectTrigger><SelectContent data-chat-search-owned><SelectItem value="all">{t('personalTools.all')}</SelectItem>{projects.map(project => <SelectItem key={project.id} value={project.path}>{project.label || project.path.split('/').pop()}</SelectItem>)}</SelectContent></Select></label>
            <label className="space-y-1"><span>{t('personalTools.after')}</span><Input type="date" value={after} onChange={event => setAfter(event.target.value)} /></label>
            <label className="space-y-1"><span>{t('personalTools.before')}</span><Input type="date" value={before} onChange={event => setBefore(event.target.value)} /></label>
            <label className="space-y-1"><span>{t('personalTools.model')}</span><Input value={model} onChange={event => setModel(event.target.value)} /></label>
          </div>
          <label className="flex items-center gap-2 typography-ui-label"><Checkbox checked={attachmentsOnly} onChange={setAttachmentsOnly} ariaLabel={t('personalTools.attachments')} /><span>{t('personalTools.attachments')}</span></label>
        </form>
        <div className="grid min-h-0 grid-cols-1 gap-4 md:grid-cols-2">
        <div className="min-h-0 max-h-[48dvh] space-y-2 overflow-y-auto" aria-busy={busy}>
          {busy && <div role="status" className="flex items-center justify-between gap-2 typography-ui-label"><span>{state ? t('personalTools.progress', { completed: state.completed, total: state.total }) : t('common.loading')}</span><Button size="sm" variant="outline" onClick={() => { stop(); setCancelled(true); }}>{t('personalTools.cancel')}</Button></div>}
          {state && !busy && <p role="status" className="sticky top-0 bg-background py-1 text-muted-foreground typography-ui-label">{t('personalTools.results', { count: state.matches.length })}</p>}
          {error && <p role="alert" className="text-status-error typography-ui-label">{t('personalTools.error')}</p>}
          {cancelled && <p role="status" className="typography-ui-label">{t('personalTools.cancelled')}</p>}
          {state?.failed ? <p role="alert" className="text-status-warning typography-ui-label">{t('personalTools.incomplete', { count: state.failed })}</p> : null}
          {state?.limited && <p role="status" className="typography-ui-label">{t('personalTools.limited')}</p>}
          {state && !busy && !error && !cancelled && !state.failed && !state.matches.length && <p className="typography-ui-label">{t('personalTools.empty')}</p>}
          {state?.matches.map(match => <button key={`${match.sessionId}/${match.messageId}`} type="button" aria-pressed={selected?.messageId === match.messageId} className={`block w-full rounded-lg p-3 text-left text-foreground focus-visible:outline focus-visible:outline-ring ${selected?.messageId === match.messageId ? 'bg-muted' : 'hover:bg-muted/50'}`} onClick={() => setSelectedId(match.messageId)}><div className="flex items-baseline justify-between gap-2 typography-ui-label"><strong>{match.title}</strong><span className="shrink-0 text-muted-foreground typography-meta">{new Date(match.created).toLocaleDateString()}</span></div><p className="mt-1 line-clamp-3 break-words typography-ui-label">{highlight(match.excerpt.replace(/\s+/g, ' ').trim())}</p><p className="mt-2 truncate text-muted-foreground typography-meta">{[match.directory.split('/').pop(), match.model, ...match.attachments].filter(Boolean).join(' · ')}</p></button>)}
        </div>
        <div className="min-h-0 max-h-[48dvh] space-y-3 overflow-y-auto rounded-xl border border-border p-4">
          <h3 className="typography-ui-label font-medium text-muted-foreground">{t('personalTools.messagePreview')}</h3>
          {selected ? <><div className="flex items-start justify-between gap-3"><h3 className="typography-ui-header font-medium">{selected.title}</h3><Button variant="outline" size="sm" onClick={() => {
            const match = selected; close();
            useSessionUIStore.getState().setCurrentSession(match.sessionId, match.directory);
            window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#search-message-${match.messageId}`);
            window.dispatchEvent(new HashChangeEvent('hashchange'));
          }}>{t('personalTools.openChat')}<Icon name="external-link" className="ml-1 size-4" /></Button></div><p title={selected.directory} className="text-muted-foreground typography-meta">{selected.directory.split('/').pop()} · {new Date(selected.created).toLocaleString()}</p><p className="whitespace-pre-wrap break-words typography-ui-label leading-relaxed">{highlight(selected.preview)}</p>{selected.previewTruncated && <p className="text-muted-foreground typography-meta">{t('personalTools.previewTruncated')}</p>}</> : <p className="text-muted-foreground typography-ui-label">{t('personalTools.previewHint')}</p>}
        </div>
        </div>
      </section>, document.body)}
  </>;
}

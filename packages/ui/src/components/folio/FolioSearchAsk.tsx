import React from 'react';
import { FolioIcon } from './FolioIcon';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useFolioStore } from '@/lib/folio/store';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';

import type { FolioNote } from '@/lib/folio/schema';

interface Hit { blockID: string; before: string; match: string; after: string }
type Result =
  | { kind: 'page'; id: string; title: string; icon: string; hit?: Hit }
  | { kind: 'ask' }
  | { kind: 'chats' };

/** The block that explains why a page matched, trimmed to a short line around the match. */
function findHit(note: FolioNote, query: string): Hit | undefined {
  const needle = query.toLowerCase();
  const words = needle.split(/\s+/).filter((word) => word.length > 1);
  let best: { blockID: string; text: string; at: number; length: number; score: number } | undefined;
  for (const block of note.blocks) {
    const lower = block.text.toLowerCase();
    const at = lower.indexOf(needle);
    if (at >= 0) { best = { blockID: block.id, text: block.text, at, length: needle.length, score: Infinity }; break; }
    const score = words.filter((word) => lower.includes(word)).length;
    if (score && (!best || score > best.score)) {
      const first = words.find((word) => lower.includes(word)) ?? '';
      best = { blockID: block.id, text: block.text, at: lower.indexOf(first), length: first.length, score };
    }
  }
  if (!best) return undefined;
  let start = Math.max(0, best.at - 36);
  if (start > 0) { const space = best.text.indexOf(' ', start); if (space >= 0 && space < best.at) start = space + 1; }
  const end = Math.min(best.text.length, best.at + best.length + 80);
  return { blockID: best.blockID, before: (start > 0 ? '…' : '') + best.text.slice(start, best.at), match: best.text.slice(best.at, best.at + best.length), after: best.text.slice(best.at + best.length, end) + (end < best.text.length ? '…' : '') };
}

/**
 * Notion-style "Search or ask": finds notes as you type, and Enter on "Ask" starts a new chat
 * with the question already in the composer. "Search chats" hands the query to the session search.
 */
export function FolioSearchAsk({ onSearchChats }: { onSearchChats: (query: string) => void }) {
  const { t } = useI18n();
  const notes = useFolioStore((s) => s.status?.notes);
  const [query, setQuery] = React.useState('');
  const [focused, setFocused] = React.useState(false);
  const [index, setIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const trimmed = query.trim();

  const results = React.useMemo<Result[]>(() => {
    if (!trimmed) return [];
    const pages = rankByQuery((notes ?? []).filter((note) => !note.trashed), trimmed, (note) => [note.title, ...note.tags, note.blocks.map((block) => block.text).join(' ')])
      .slice(0, 6)
      .map((note): Result => ({ kind: 'page', id: note.id, title: note.title, icon: note.icon, hit: findHit(note, trimmed) }));
    return [{ kind: 'ask' }, ...pages, { kind: 'chats' }];
  }, [notes, trimmed]);

  React.useEffect(() => setIndex(0), [trimmed]);
  React.useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'k') { event.preventDefault(); inputRef.current?.focus(); }
    };
    window.addEventListener('keydown', focus);
    return () => window.removeEventListener('keydown', focus);
  }, []);

  const choose = (result: Result | undefined) => {
    if (!result) return;
    if (result.kind === 'page') {
      useUIStore.getState().closeMainSurfaces();
      useFolioStore.getState().setFound(result.hit ? { noteID: result.id, blockID: result.hit.blockID, query: result.hit.match } : undefined);
      void useFolioStore.getState().run({ command: 'select', noteID: result.id });
    } else if (result.kind === 'ask') {
      void useFolioStore.getState().close();
      useUIStore.getState().closeMainSurfaces();
      useSessionUIStore.getState().openNewSessionDraft();
      useInputStore.getState().setPendingInputText(trimmed, 'replace');
    } else {
      onSearchChats(trimmed);
    }
    setQuery('');
    inputRef.current?.blur();
  };

  return <div className="relative px-2.5 pb-2 pt-1">
    <div className={cn('flex h-8 items-center gap-2 rounded-lg border border-border/70 bg-background/40 px-2.5 text-sm text-muted-foreground', focused && 'border-border text-foreground')}>
      <Icon name="search" className="size-3.5 shrink-0" />
      <input
        ref={inputRef}
        className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
        placeholder={t('folio.searchOrAsk')}
        aria-label={t('folio.searchOrAsk')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 120)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((i) => Math.min(results.length - 1, i + 1)); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
          else if (event.key === 'Enter' && trimmed) { event.preventDefault(); choose(results[index]); }
          else if (event.key === 'Escape') { setQuery(''); inputRef.current?.blur(); }
        }}
      />
      <kbd className="shrink-0 text-[10px] text-muted-foreground/70">⌘⇧K</kbd>
    </div>
    {focused && results.length > 0 && <div role="listbox" className="absolute inset-x-2.5 top-full z-50 mt-1 overflow-hidden rounded-lg border border-border bg-background py-1 shadow-xl">
      {results.map((result, i) => (
        <button key={result.kind === 'page' ? result.id : result.kind} type="button" role="option" aria-selected={i === index}
          className={cn('flex w-full items-start gap-2 px-3 py-1.5 text-left text-sm', i === index && 'bg-interactive-selection')}
          onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setIndex(i)} onClick={() => choose(result)}>
          {result.kind === 'page' && <><span className="mt-0.5 shrink-0"><FolioIcon value={result.icon} /></span><span className="min-w-0 flex-1">
            <span className="block truncate">{result.title || t('folio.untitled')}</span>
            {result.hit && <span className="line-clamp-2 text-xs text-muted-foreground">{result.hit.before}<mark className="rounded-sm bg-[color-mix(in_srgb,var(--status-warning)_35%,transparent)] px-0.5 text-foreground">{result.hit.match}</mark>{result.hit.after}</span>}
          </span></>}
          {result.kind === 'ask' && <><Icon name="sparkling" className="mt-0.5 size-4 shrink-0 text-primary" /><span className="truncate">{t('folio.ask')}: “{trimmed}”</span></>}
          {result.kind === 'chats' && <><Icon name="search" className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span className="truncate text-muted-foreground">{t('folio.searchChats')} “{trimmed}”</span></>}
        </button>
      ))}
    </div>}
  </div>;
}

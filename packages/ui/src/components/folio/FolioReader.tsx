import React from 'react';
import { z } from 'zod';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { FolioBlock, FolioNote } from '@/lib/folio/schema';

/**
 * Book-style reading mode for a page: paginated like Apple Books, with the page count, pages left
 * in the chapter, a saved place, bookmarks, contents, page colors and text size. Headings start
 * new chapters. Settings and places are kept on this device.
 */

const settingsSchema = z.object({
  page: z.enum(['auto', 'night', 'sepia', 'paper']),
  font: z.enum(['original', 'serif', 'sans']),
  size: z.number().min(13).max(34),
  spacing: z.number().min(1.2).max(2),
});
type ReaderSettings = z.infer<typeof settingsSchema>;
const placeSchema = z.object({ blockID: z.string(), at: z.number() });
const marksSchema = z.array(z.object({ blockID: z.string(), label: z.string(), at: z.number() }));
type Bookmark = z.infer<typeof marksSchema>[number];

const SETTINGS = 'folio.reader.settings';
const placeKey = (id: string) => `folio.reader.place.${id}`;
const marksKey = (id: string) => `folio.reader.marks.${id}`;
function load<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
  try { const raw = localStorage.getItem(key); if (!raw) return fallback; const parsed = schema.safeParse(JSON.parse(raw)); return parsed.success ? parsed.data : fallback; } catch { return fallback; }
}
function keep<T>(key: string, value: T) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked */ } }

const pages: readonly ReaderSettings['page'][] = ['auto', 'night', 'sepia', 'paper'];
const fonts: readonly ReaderSettings['font'][] = ['original', 'serif', 'sans'];
const chapterKinds = new Set<FolioBlock['kind']>(['heading1', 'heading2', 'toggleHeading1', 'toggleHeading2']);
const GAP = 64;

/** Inline formatting (bold, italic, links…) as React nodes. */
function Inline({ block }: { block: FolioBlock }) {
  const text = block.text;
  const marks = (block.marks ?? []).filter((m) => m.length > 0);
  if (!marks.length) return <>{text}</>;
  const cuts = [...new Set([0, text.length, ...marks.flatMap((m) => [m.start, Math.min(text.length, m.start + m.length)])])].sort((a, b) => a - b);
  const parts: React.ReactNode[] = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const from = cuts[i], to = cuts[i + 1];
    let node: React.ReactNode = text.slice(from, to);
    for (const mark of marks.filter((m) => m.start <= from && m.start + m.length >= to)) {
      if (mark.style === 'bold') node = <strong>{node}</strong>;
      else if (mark.style === 'italic') node = <em>{node}</em>;
      else if (mark.style === 'underline') node = <u>{node}</u>;
      else if (mark.style === 'strike') node = <s>{node}</s>;
      else if (mark.style === 'code') node = <code>{node}</code>;
      else if (mark.style === 'highlight') node = <mark>{node}</mark>;
      else if (mark.style === 'link' && mark.value && /^https?:/i.test(mark.value)) node = <a href={mark.value} target="_blank" rel="noreferrer">{node}</a>;
    }
    parts.push(<React.Fragment key={from}>{node}</React.Fragment>);
  }
  return <>{parts}</>;
}

function BookBlock({ block, index, number }: { block: FolioBlock; index: number; number: number }) {
  const common = { 'data-block': block.id, style: block.indent ? { marginLeft: `${block.indent * 1.2}em` } : undefined };
  switch (block.kind) {
    case 'heading1': case 'toggleHeading1': return <h1 {...common} className={cn(index > 0 && 'folio-reader-chapter')}><Inline block={block} /></h1>;
    case 'heading2': case 'toggleHeading2': return <h2 {...common} className={cn(index > 0 && 'folio-reader-chapter')}><Inline block={block} /></h2>;
    case 'heading3': case 'toggleHeading3': return <h3 {...common}><Inline block={block} /></h3>;
    case 'heading4': case 'toggleHeading4': return <h4 {...common}><Inline block={block} /></h4>;
    case 'bullet': return <p {...common} className="folio-reader-item"><span aria-hidden>•</span><Inline block={block} /></p>;
    case 'numbered': return <p {...common} className="folio-reader-item"><span aria-hidden>{number}.</span><Inline block={block} /></p>;
    case 'task': return <p {...common} className="folio-reader-item"><span aria-hidden>{block.checked ? '☑' : '☐'}</span><Inline block={block} /></p>;
    case 'quote': case 'callout': return <blockquote {...common}><Inline block={block} /></blockquote>;
    case 'code': case 'equation': return <pre {...common}>{block.text}</pre>;
    case 'divider': return <p {...common} className="folio-reader-divider" aria-hidden>⁂</p>;
    case 'attachment': return <p {...common} className="folio-reader-file">{block.text}</p>;
    case 'page': case 'pageIn': return null;
    default: return block.text.trim() ? <p {...common}><Inline block={block} /></p> : null;
  }
}

export function FolioReader({ note, onClose, onListen, startAt, onPlace }: { note: FolioNote; onClose: () => void; onListen?: (text: string) => void; startAt?: string; onPlace?: (blockID: string) => void }) {
  const { t } = useI18n();
  const [settings, setSettings] = React.useState<ReaderSettings>(() => load(SETTINGS, settingsSchema, { page: 'auto', font: 'original', size: window.innerWidth < 700 ? 20 : 21, spacing: 1.5 }));
  const [marks, setMarks] = React.useState<Bookmark[]>(() => load(marksKey(note.id), marksSchema, []));
  const [page, setPage] = React.useState(0);
  const [total, setTotal] = React.useState(1);
  const [chapterStarts, setChapterStarts] = React.useState<number[]>([]);
  const [chrome, setChrome] = React.useState(true);
  const [panel, setPanel] = React.useState<'none' | 'menu' | 'contents' | 'marks'>('none');
  const frame = React.useRef<HTMLDivElement>(null);
  const flow = React.useRef<HTMLDivElement>(null);
  const [size, setSize] = React.useState({ width: 0, height: 0 });
  const anchor = React.useRef<string | undefined>(startAt ?? (load(placeKey(note.id), placeSchema, { blockID: '', at: 0 }).blockID || undefined));
  const drag = React.useRef<{ x: number; y: number } | undefined>(undefined);

  const blocks = note.blocks;
  const numbers = React.useMemo(() => { let n = 0; return blocks.map((b) => (b.kind === 'numbered' ? (n += 1) : (n = 0))); }, [blocks]);
  const chapters = React.useMemo(() => blocks.filter((b) => chapterKinds.has(b.kind) && b.text.trim()), [blocks]);
  // Two pages side by side on a wide window, one on a phone.
  const wide = window.innerWidth >= 1100;
  const columns = wide && size.width >= 900 ? 2 : 1;
  const columnWidth = columns === 2 ? (size.width - GAP) / 2 : size.width;
  const step = size.width + GAP;

  React.useEffect(() => keep(SETTINGS, settings), [settings]);

  React.useLayoutEffect(() => {
    const element = frame.current; if (!element) return;
    const measure = () => setSize({ width: Math.floor(element.clientWidth), height: Math.floor(element.clientHeight) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const pageOf = React.useCallback((element: Element) => {
    const origin = flow.current?.getBoundingClientRect().left ?? 0;
    return Math.max(0, Math.floor((element.getBoundingClientRect().left - origin + 1) / step));
  }, [step]);

  // Re-paginate when the size, text size or font changes, staying on the same passage.
  React.useLayoutEffect(() => {
    const element = flow.current; if (!element || !size.width) return;
    const count = Math.max(1, Math.round((element.scrollWidth + GAP) / step));
    setTotal(count);
    setChapterStarts(chapters.flatMap((c) => { const found = element.querySelector(`[data-block="${c.id}"]`); return found ? [pageOf(found)] : []; }));
    const target = anchor.current ? element.querySelector(`[data-block="${anchor.current}"]`) : null;
    setPage(target ? Math.min(count - 1, pageOf(target)) : 0);
  }, [size, settings.size, settings.font, settings.spacing, blocks, chapters, step, pageOf]);

  /** The passage showing at the top of a page (the last one that starts on or before it): the saved place and the bookmark target. */
  const firstBlockOn = React.useCallback((index: number): string | undefined => {
    const element = flow.current; if (!element) return undefined;
    // Passages are in page order, so a binary search keeps long books quick.
    const children = element.querySelectorAll('[data-block]');
    let low = 0, high = children.length - 1, found: Element | undefined;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (pageOf(children[middle]) <= index) { found = children[middle]; low = middle + 1; } else high = middle - 1;
    }
    return found?.getAttribute('data-block') ?? undefined;
  }, [pageOf]);

  const go = React.useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(total - 1, next));
    setPage(clamped);
    const blockID = firstBlockOn(clamped);
    anchor.current = blockID;
    if (blockID) { keep(placeKey(note.id), { blockID, at: Date.now() }); onPlace?.(blockID); }
  }, [total, firstBlockOn, note.id, onPlace]);

  const jumpTo = (blockID: string) => {
    const found = flow.current?.querySelector(`[data-block="${blockID}"]`);
    if (found) go(pageOf(found));
    setPanel('none');
  };

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { if (panel !== 'none') setPanel('none'); else onClose(); }
      else if (event.key === 'ArrowRight' || event.key === ' ' || event.key === 'PageDown') { event.preventDefault(); go(page + 1); }
      else if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); go(page - 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, page, panel, onClose]);

  const nextChapter = chapterStarts.find((start) => start > page);
  const left = (nextChapter ?? total) - page - 1;
  const chapterLine = chapters.length
    ? (left <= 0 ? t('folio.readerLastPageChapter') : left === 1 ? t('folio.readerOnePageLeftChapter') : t('folio.readerPagesLeftChapter', { count: left }))
    : (left <= 0 ? t('folio.readerLastPage') : left === 1 ? t('folio.readerOnePageLeft') : t('folio.readerPagesLeft', { count: left }));
  const currentBlock = firstBlockOn(page);
  const marked = marks.find((m) => m.blockID === currentBlock);
  const toggleMark = () => {
    if (!currentBlock) return;
    const block = blocks.find((b) => b.id === currentBlock);
    const next = marked ? marks.filter((m) => m !== marked) : [...marks, { blockID: currentBlock, label: (block?.text || note.title).slice(0, 80), at: Date.now() }];
    setMarks(next); keep(marksKey(note.id), next);
  };
  const listen = () => {
    const from = Math.max(0, blocks.findIndex((b) => b.id === currentBlock));
    onListen?.(blocks.slice(from).map((b) => b.text).filter(Boolean).join('\n\n'));
    setPanel('none');
  };

  // Taps: left third back, right third forward, middle shows or hides the controls. Swipes turn pages.
  const onPointerDown = (event: React.PointerEvent) => { drag.current = { x: event.clientX, y: event.clientY }; };
  const onPointerUp = (event: React.PointerEvent) => {
    const start = drag.current; drag.current = undefined;
    if (!start || panel !== 'none') { setPanel('none'); return; }
    if (event.target instanceof Element && event.target.closest('a')) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) { go(page + (dx < 0 ? 1 : -1)); return; }
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) return;
    const x = event.clientX / window.innerWidth;
    if (x < 0.3) go(page - 1); else if (x > 0.7) go(page + 1); else setChrome(!chrome);
  };

  const fontFamily = settings.font === 'sans' ? 'var(--font-sans, system-ui)' : settings.font === 'serif' ? 'ui-serif, "New York", Georgia, serif' : '"Iowan Old Style", "Palatino", ui-serif, Georgia, serif';
  const round = 'flex size-11 items-center justify-center rounded-full bg-[var(--reader-control)] text-[var(--reader-muted)] backdrop-blur';
  const row = 'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[15px] active:bg-[var(--reader-control)]';

  return <div role="dialog" aria-modal aria-label={t('folio.readerTitle')} data-page={settings.page} lang="en"
    className="folio-reader fixed inset-0 z-[70] flex select-none flex-col bg-[var(--reader-bg)] text-[var(--reader-text)]">
    <div className={cn('relative flex h-[calc(env(safe-area-inset-top)+56px)] shrink-0 items-end justify-center px-5 pb-2 transition-opacity', !chrome && 'opacity-0')}>
      <span className="pb-2.5 text-[13px] text-[var(--reader-muted)]">{chapterLine}</span>
      <button type="button" className={cn(round, 'absolute bottom-1 right-4')} aria-label={t('folio.readerClose')} onClick={onClose}><Icon name="close" className="size-6" /></button>
    </div>

    <div ref={frame} className="relative min-h-0 flex-1 overflow-hidden" style={wide ? { width: 'min(1180px, calc(100% - 144px))', marginInline: 'auto' } : { marginInline: 28 }} onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
      <div ref={flow} className="folio-reader-flow h-full"
        style={{ width: size.width || '100%', columnWidth, columnGap: GAP, columnFill: 'auto', fontFamily, fontSize: settings.size, lineHeight: settings.spacing, transform: `translateX(${-page * step}px)` }}>
        <h1 className="folio-reader-title">{note.title || t('folio.untitled')}</h1>
        {blocks.map((block, i) => <BookBlock key={block.id} block={block} index={i} number={numbers[i]} />)}
        {note.table && <p>{note.table.rows.map((r) => note.table?.columns.map((c) => r.values[c.id] ?? '').filter(Boolean).join(' · ')).join('\n')}</p>}
      </div>
    </div>

    <div className={cn('relative flex h-[calc(env(safe-area-inset-bottom)+64px)] shrink-0 items-start justify-center px-5 pt-3 transition-opacity', !chrome && 'opacity-0')}>
      <button type="button" className={cn(round, 'absolute left-4 top-1')} aria-pressed={Boolean(marked)} aria-label={marked ? t('folio.readerRemoveBookmark') : t('folio.readerAddBookmark')} onClick={toggleMark}>
        {marked ? <Icon name="bookmark-fill" className="size-5 text-[var(--reader-accent)]" /> : <Icon name="bookmark" className="size-5" />}
      </button>
      <span className="pt-2.5 text-[13px] tabular-nums text-[var(--reader-muted)]">{t('folio.readerPageOf', { page: page + 1, total })}</span>
      <button type="button" className={cn(round, 'absolute right-4 top-1')} aria-label={t('folio.readerMenu')} aria-expanded={panel !== 'none'} onClick={() => setPanel(panel === 'none' ? 'menu' : 'none')}>
        <Icon name="list-unordered" className="size-5" />
      </button>
    </div>

    {panel !== 'none' && <div className="absolute bottom-[calc(env(safe-area-inset-bottom)+72px)] right-4 z-10 max-h-[70vh] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl bg-[var(--reader-sheet)] p-2 text-[var(--reader-text)] shadow-2xl"
      onPointerUp={(event) => event.stopPropagation()}>
      {panel === 'menu' && <>
        {chapters.length > 0 && <button type="button" className={row} onClick={() => setPanel('contents')}><Icon name="list-unordered" className="size-5 text-[var(--reader-muted)]" />{t('folio.readerContents')}</button>}
        <button type="button" className={row} onClick={() => setPanel('marks')}><Icon name="bookmark" className="size-5 text-[var(--reader-muted)]" />{t('folio.readerBookmarks')}{marks.length > 0 && <span className="ml-auto text-[var(--reader-muted)]">{marks.length}</span>}</button>
        {onListen && <button type="button" className={row} onClick={listen}><Icon name="volume-up" className="size-5 text-[var(--reader-muted)]" />{t('folio.readerListen')}</button>}
        <div className="mx-2 my-2 border-t border-[var(--reader-line)]" />
        <div className="flex items-center gap-2 px-2 py-1.5">
          <button type="button" className={cn(round, 'size-10 text-sm')} aria-label={t('folio.readerSmaller')} onClick={() => setSettings({ ...settings, size: Math.max(13, settings.size - 1) })}>A</button>
          <span className="flex-1 text-center text-sm tabular-nums text-[var(--reader-muted)]">{settings.size}</span>
          <button type="button" className={cn(round, 'size-10 text-xl')} aria-label={t('folio.readerLarger')} onClick={() => setSettings({ ...settings, size: Math.min(34, settings.size + 1) })}>A</button>
        </div>
        <div role="radiogroup" aria-label={t('folio.readerPageColor')} className="flex justify-between gap-2 px-2 py-2">
          {pages.map((value) => <button key={value} type="button" role="radio" aria-checked={settings.page === value} aria-label={t(`folio.readerPage.${value}`)} data-swatch={value}
            className={cn('folio-reader-swatch h-10 flex-1 rounded-xl border text-xs', settings.page === value ? 'border-[var(--reader-accent)] ring-2 ring-[var(--reader-accent)]' : 'border-[var(--reader-line)]')}
            onClick={() => setSettings({ ...settings, page: value })}>{t(`folio.readerPage.${value}`)}</button>)}
        </div>
        <div role="radiogroup" aria-label={t('folio.readerFont')} className="flex gap-2 px-2 py-2">
          {fonts.map((value) => <button key={value} type="button" role="radio" aria-checked={settings.font === value}
            className={cn('h-10 flex-1 rounded-xl border text-sm', settings.font === value ? 'border-[var(--reader-accent)]' : 'border-[var(--reader-line)]')}
            style={{ fontFamily: value === 'sans' ? 'system-ui' : value === 'serif' ? 'ui-serif, Georgia, serif' : '"Iowan Old Style", Palatino, serif' }}
            onClick={() => setSettings({ ...settings, font: value })}>{t(`folio.readerFont.${value}`)}</button>)}
        </div>
        <div className="flex items-center gap-3 px-3 py-2 text-sm">
          <span className="text-[var(--reader-muted)]">{t('folio.readerSpacing')}</span>
          <input type="range" min={1.2} max={2} step={0.1} value={settings.spacing} aria-label={t('folio.readerSpacing')} className="flex-1" onChange={(e) => setSettings({ ...settings, spacing: Number(e.target.value) })} />
        </div>
      </>}
      {panel === 'contents' && <>
        <button type="button" className={cn(row, 'text-[var(--reader-muted)]')} onClick={() => setPanel('menu')}><Icon name="arrow-left-s" className="size-5" />{t('folio.readerContents')}</button>
        {chapters.map((c, i) => <button key={c.id} type="button" className={row} onClick={() => jumpTo(c.id)}>
          <span className={cn('min-w-0 flex-1 truncate', c.kind.endsWith('2') && 'pl-3')}>{c.text}</span>
          {chapterStarts[i] !== undefined && <span className="text-sm tabular-nums text-[var(--reader-muted)]">{chapterStarts[i] + 1}</span>}
        </button>)}
      </>}
      {panel === 'marks' && <>
        <button type="button" className={cn(row, 'text-[var(--reader-muted)]')} onClick={() => setPanel('menu')}><Icon name="arrow-left-s" className="size-5" />{t('folio.readerBookmarks')}</button>
        {!marks.length && <p className="px-3 py-3 text-sm text-[var(--reader-muted)]">{t('folio.readerNoBookmarks')}</p>}
        {marks.slice().sort((a, b) => b.at - a.at).map((mark) => <button key={mark.blockID} type="button" className={row} onClick={() => jumpTo(mark.blockID)}>
          <Icon name="bookmark" className="size-4 shrink-0 text-[var(--reader-accent)]" /><span className="min-w-0 flex-1 truncate">{mark.label}</span>
        </button>)}
      </>}
    </div>}
  </div>;
}

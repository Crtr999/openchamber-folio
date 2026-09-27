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
    case 'page': case 'pageIn': case 'database': case 'button': return null;
    case 'table': return <table {...common} className="folio-reader-table"><tbody>{block.text.split('\n').map((line, r) => <tr key={r}>{line.split('\t').map((cell, c) => <td key={c}>{cell}</td>)}</tr>)}</tbody></table>;
    default: return block.text.trim() ? <p {...common}><Inline block={block} /></p> : null;
  }
}

/** One part of the book, laid out in columns. Memoized so turning a page never re-renders the text. */
const BookPart = React.memo(function BookPart({ title, blocks, numbers, table }: { title?: string; blocks: readonly FolioBlock[]; numbers: readonly number[]; table?: string }) {
  return <>
    {title !== undefined && <h1 className="folio-reader-title">{title}</h1>}
    {blocks.map((block, i) => <BookBlock key={block.id} block={block} index={i} number={numbers[i]} />)}
    {table && <p>{table}</p>}
  </>;
});

/**
 * Long books are laid out one part at a time (about a hundred and fifty passages, split at
 * chapters where possible): laying out a whole book in columns at once made opening and turning
 * pages slow. Every change of width or text size justifies and hyphenates the whole part again,
 * so the part is kept small enough to lay out quickly.
 */
const PART_SIZE = 150;
function splitParts(blocks: readonly FolioBlock[]): Array<{ from: number; to: number }> {
  const parts: Array<{ from: number; to: number }> = [];
  let from = 0;
  while (from < blocks.length) {
    let to = Math.min(blocks.length, from + PART_SIZE);
    if (to < blocks.length) {
      // Prefer ending just before a chapter heading in the last third of the part.
      for (let i = to; i > from + Math.floor(PART_SIZE * 0.66); i -= 1) if (chapterKinds.has(blocks[i].kind)) { to = i; break; }
    }
    parts.push({ from, to });
    from = to;
  }
  return parts.length ? parts : [{ from: 0, to: 0 }];
}
const textLength = (blocks: readonly FolioBlock[]) => blocks.reduce((n, b) => n + b.text.length + 40, 0);
const sameNumbers = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((value, i) => value === b[i]);

export function FolioReader({ note, onClose, onListen, startAt, onPlace }: { note: FolioNote; onClose: () => void; onListen?: (text: string) => void; startAt?: string; onPlace?: (blockID: string) => void }) {
  const { t } = useI18n();
  const [settings, setSettings] = React.useState<ReaderSettings>(() => load(SETTINGS, settingsSchema, { page: 'auto', font: 'original', size: window.innerWidth < 700 ? 20 : 21, spacing: 1.5 }));
  const [marks, setMarks] = React.useState<Bookmark[]>(() => load(marksKey(note.id), marksSchema, []));
  const [page, setPage] = React.useState(0);
  const [total, setTotal] = React.useState(1);
  const blocksAll = note.blocks;
  const parts = React.useMemo(() => splitParts(blocksAll), [blocksAll]);
  const partOfBlock = React.useCallback((blockID: string | undefined) => {
    const index = blockID ? blocksAll.findIndex((b) => b.id === blockID) : -1;
    return index < 0 ? 0 : Math.max(0, parts.findIndex((p) => index >= p.from && index < p.to));
  }, [blocksAll, parts]);
  const [part, setPart] = React.useState(0);
  /** Measured page counts of parts already laid out; others are estimated from their length. */
  const counts = React.useRef(new Map<number, number>());
  const pendingEnd = React.useRef(false);
  const [chapterStarts, setChapterStarts] = React.useState<number[]>([]);
  const storedStarts = React.useRef<number[]>([]);
  const [chrome, setChrome] = React.useState(true);
  const [panel, setPanel] = React.useState<'none' | 'menu' | 'contents' | 'marks'>('none');
  const frame = React.useRef<HTMLDivElement>(null);
  const flow = React.useRef<HTMLDivElement>(null);
  const probe = React.useRef<HTMLSpanElement>(null);
  /** The frame and flow widths in pixels. The page box is capped and centred by its own CSS and the
      flow fills it, so the flow's rendered width, not the frame's, is what the columns and the page
      step follow. */
  const [widths, setWidths] = React.useState({ frame: 0, flow: 0 });
  /** The reading measure in pixels: what the page box's 68ch cap comes to in the font it is set in. */
  const [measure, setMeasure] = React.useState(0);
  const anchor = React.useRef<string | undefined>(startAt ?? (load(placeKey(note.id), placeSchema, { blockID: '', at: 0 }).blockID || undefined));
  React.useLayoutEffect(() => { setPart(partOfBlock(anchor.current)); }, [partOfBlock]);
  const drag = React.useRef<{ x: number; y: number } | undefined>(undefined);

  const range = parts[Math.min(part, parts.length - 1)];
  const blocks = React.useMemo(() => blocksAll.slice(range.from, range.to), [blocksAll, range]);
  const numbers = React.useMemo(() => { let n = 0; return blocks.map((b) => (b.kind === 'numbered' ? (n += 1) : (n = 0))); }, [blocks]);
  const allChapters = React.useMemo(() => blocksAll.filter((b) => chapterKinds.has(b.kind) && b.text.trim()), [blocksAll]);
  const chapters = React.useMemo(() => blocks.filter((b) => chapterKinds.has(b.kind) && b.text.trim()), [blocks]);
  const tableText = React.useMemo(() => (part === parts.length - 1 && note.table ? note.table.rows.map((r) => note.table?.columns.map((c) => r.values[c.id] ?? '').filter(Boolean).join(' · ')).join('\n') : undefined), [note.table, part, parts.length]);
  const wide = window.innerWidth >= 1100;
  // One page on a phone; two side by side on a wide window, but only once the frame is wide enough
  // for each of them to hold the whole measure. Below that one page is kept, which the cap then
  // centres, so the text never runs out to the edge of the window.
  const columns = wide && measure > 0 && widths.frame >= 2 * measure + GAP ? 2 : 1;
  // The columns divide the flow's own width. The browser is told how many there are and not how
  // wide each one is, because a column width is only a suggestion: the browser fits as many as it
  // can, so one measured a moment too early lays out four narrow columns where two wide ones
  // belong, and the page step no longer divides them. With C columns of used width cw in a flow of
  // F, F is C * cw and (C - 1) gaps, so the step F + GAP below is exactly C column pitches: page p
  // starts at column p * C and every page boundary lands on a column boundary. The width is unknown
  // until the observer has measured it, and the flow carries no padding that would shift it.
  const step = widths.flow + GAP;

  React.useEffect(() => keep(SETTINGS, settings), [settings]);

  React.useLayoutEffect(() => {
    const frameElement = frame.current, flowElement = flow.current;
    if (!frameElement || !flowElement) return;
    // Resize callbacks come in bursts, and a resize that moves no width changes no page, so a
    // measurement that matches what is stored is dropped: storing it would re-run the pagination
    // and lay the whole part out again. The height is not read at all, as no page depends on it.
    // The flow is measured, not rounded: the cap is written in characters, so its width is rarely a
    // whole number of pixels, and a step rounded down from it comes up short of a whole column on
    // every page turned.
    const readWidths = () => {
      const frameWidth = Math.floor(frameElement.clientWidth);
      const flowWidth = flowElement.getBoundingClientRect().width;
      setWidths((current) => current.frame === frameWidth && current.flow === flowWidth ? current : { frame: frameWidth, flow: flowWidth });
    };
    readWidths();
    const observer = new ResizeObserver(readWidths);
    observer.observe(frameElement);
    observer.observe(flowElement);
    return () => observer.disconnect();
  }, []);

  /**
   * The measure is written in characters, and a character resolves against the font the browser
   * actually picked, so a hidden probe set in the text's own font is measured instead of guessed.
   * Only the font and the text size change the width of a character, so this runs for those two
   * and never during a resize; until it has run the reader lays out one capped page, which is
   * already centred, so nothing about the first page depends on it.
   */
  React.useLayoutEffect(() => {
    const element = probe.current; if (!element) return;
    setMeasure(element.offsetWidth);
  }, [settings.font, settings.size]);

  const pageOf = React.useCallback((element: Element) => {
    const origin = flow.current?.getBoundingClientRect().left ?? 0;
    return Math.max(0, Math.floor((element.getBoundingClientRect().left - origin + 1) / step));
  }, [step]);

  // Re-paginate when the size, text size or font changes, staying on the same passage.
  React.useLayoutEffect(() => {
    const element = flow.current; if (!element || !widths.flow) return;
    // The flow's width is capped in characters, so new text can move it while this part is still
    // laid out at the previous width. Paginating that width would count pages against a step the
    // next pass no longer uses, and the observer storing the new width runs after this effect. The
    // width is read the way it was stored and not as a whole number of pixels: clientWidth rounds a
    // fractional width up, so the two disagree by a pixel on roughly half the widths a count of
    // characters produces, and then this effect never counts a page again.
    if (element.getBoundingClientRect().width !== widths.flow) return;
    const count = Math.max(1, Math.round((element.scrollWidth + GAP) / step));
    counts.current.set(part, count);
    setTotal(count);
    const starts = chapters.flatMap((c) => { const found = element.querySelector(`[data-block="${c.id}"]`); return found ? [pageOf(found)] : []; });
    // A new array is a new render, and nothing moved when the chapter pages came back the same.
    if (!sameNumbers(storedStarts.current, starts)) { storedStarts.current = starts; setChapterStarts(starts); }
    if (pendingEnd.current) { pendingEnd.current = false; setPage(count - 1); return; }
    const target = anchor.current ? element.querySelector(`[data-block="${anchor.current}"]`) : null;
    setPage(target ? Math.min(count - 1, pageOf(target)) : 0);
  }, [widths.flow, settings.size, settings.font, settings.spacing, blocks, chapters, step, pageOf, part]);
  // Sizes change page counts everywhere: measured counts of other parts are stale.
  React.useEffect(() => { const keepPart = counts.current.get(part); counts.current.clear(); if (keepPart) counts.current.set(part, keepPart); }, [widths.flow, settings.size, settings.font, settings.spacing]); // eslint-disable-line react-hooks/exhaustive-deps -- only layout inputs invalidate
  const lengths = React.useMemo(() => parts.map((p) => textLength(blocksAll.slice(p.from, p.to))), [parts, blocksAll]);
  const pagesOf = (index: number) => counts.current.get(index) ?? Math.max(1, Math.round((lengths[index] / Math.max(1, lengths[part])) * total));
  const before = parts.slice(0, part).reduce((n, _, i) => n + pagesOf(i), 0);
  const overall = parts.reduce((n, _, i) => n + (i === part ? total : pagesOf(i)), 0);
  const estimated = parts.some((_, i) => i !== part && !counts.current.has(i));

  /** The passage showing at the top of a page (the last one that starts on or before it): the saved place and the bookmark target. */
  // Finding it measures the flow, which lays the whole part out, so the last answer is kept:
  // turning a page asks for the same passage twice, and renders that changed no paging must not
  // measure at all.
  const placed = React.useRef<{ blocks: readonly FolioBlock[]; index: number; step: number; blockID: string | undefined }>({ blocks: [], index: -1, step: -1, blockID: undefined });
  const firstBlockOn = React.useCallback((index: number): string | undefined => {
    const element = flow.current; if (!element) return undefined;
    const cache = placed.current;
    if (cache.index === index && cache.step === step && cache.blocks === blocks) return cache.blockID;
    // Passages are in page order, so a binary search keeps long books quick.
    const children = element.querySelectorAll('[data-block]');
    let low = 0, high = children.length - 1, found: Element | undefined;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (pageOf(children[middle]) <= index) { found = children[middle]; low = middle + 1; } else high = middle - 1;
    }
    const blockID = found?.getAttribute('data-block') ?? undefined;
    cache.index = index; cache.step = step; cache.blocks = blocks; cache.blockID = blockID;
    return blockID;
  }, [pageOf, step, blocks]);

  // The saved place and the other device's "continue reading" update once reading pauses, not on every page.
  const placeTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(placeTimer.current), []);
  const go = React.useCallback((next: number) => {
    if (next >= total && part < parts.length - 1) { anchor.current = blocksAll[parts[part + 1].from]?.id; setPart(part + 1); return; }
    if (next < 0 && part > 0) { pendingEnd.current = true; anchor.current = undefined; setPart(part - 1); return; }
    const clamped = Math.max(0, Math.min(total - 1, next));
    setPage(clamped);
    const blockID = firstBlockOn(clamped);
    anchor.current = blockID;
    clearTimeout(placeTimer.current);
    if (blockID) placeTimer.current = setTimeout(() => { keep(placeKey(note.id), { blockID, at: Date.now() }); onPlace?.(blockID); }, 1200);
  }, [total, firstBlockOn, note.id, onPlace, part, parts, blocksAll]);

  const jumpTo = (blockID: string) => {
    const target = partOfBlock(blockID);
    anchor.current = blockID;
    if (target !== part) setPart(target);
    else { const found = flow.current?.querySelector(`[data-block="${blockID}"]`); if (found) go(pageOf(found)); }
    setPanel('none');
  };

  // Trackpad: a two-finger swipe left or right turns one page.
  const wheel = React.useRef({ sum: 0, locked: 0 });
  const onWheel = (event: React.WheelEvent) => {
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    const now = Date.now();
    if (now < wheel.current.locked) return;
    wheel.current.sum += event.deltaX;
    if (Math.abs(wheel.current.sum) > 50) { go(page + (wheel.current.sum > 0 ? 1 : -1)); wheel.current = { sum: 0, locked: now + 450 }; }
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

  const nextChapter = chapterStarts.find((start) => start > page) ?? (part < parts.length - 1 && allChapters.some((c) => blocksAll.findIndex((b) => b.id === c.id) === parts[part + 1].from) ? total : undefined);
  const left = (nextChapter ?? total) - page - 1;
  const chapterLine = allChapters.length
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
    const from = Math.max(0, blocksAll.findIndex((b) => b.id === currentBlock));
    onListen?.(blocksAll.slice(from).map((b) => b.text).filter(Boolean).join('\n\n'));
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
  // The page, the text in it and the probe that measures the measure are set in one style: the cap
  // is written in characters, so it has to resolve against the font the text is set in, and the
  // pixels the probe reports have to be the ones the text is laid out in.
  const type: React.CSSProperties = { fontFamily, fontSize: settings.size };
  const round = 'flex size-11 items-center justify-center rounded-full bg-[var(--reader-control)] text-[var(--reader-muted)] backdrop-blur';
  const row = 'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[15px] active:bg-[var(--reader-control)]';

  return <div role="dialog" aria-modal aria-label={t('folio.readerTitle')} data-page={settings.page} lang="en"
    className="folio-reader fixed inset-0 z-[70] flex select-none flex-col bg-[var(--reader-bg)] text-[var(--reader-text)]">
    <div className={cn('relative flex h-[calc(env(safe-area-inset-top)+56px)] shrink-0 items-end justify-center px-5 pb-2 transition-opacity', !chrome && 'opacity-0')}>
      <span className="pb-2.5 text-[13px] text-[var(--reader-muted)]">{chapterLine}</span>
      <button type="button" className={cn(round, 'absolute bottom-1 right-4')} aria-label={t('folio.readerClose')} onClick={onClose}><Icon name="close" className="size-6" /></button>
    </div>

    <div className="group/pages relative flex min-h-0 flex-1">
    <div ref={frame} className="relative min-h-0 flex-1 overflow-hidden" style={wide ? undefined : { marginInline: 28 }} onPointerDown={onPointerDown} onPointerUp={onPointerUp} onWheel={onWheel}>
      <span ref={probe} aria-hidden className="folio-reader-probe" style={type} />
      {/* One page of the book, capped and centred, and the box that clips it. The flow is as wide
          as the whole book, so the columns either side of the page have to be clipped here: a frame
          wider than the page would show them. */}
      <div className="folio-reader-page h-full" data-columns={columns} style={type}>
        <div ref={flow} className="folio-reader-flow h-full"
          style={{ columnCount: columns, columnGap: GAP, columnFill: 'auto', lineHeight: settings.spacing, transform: `translateX(${-page * step}px)` }}>
          <BookPart title={part === 0 ? note.title || t('folio.untitled') : undefined} blocks={blocks} numbers={numbers} table={tableText} />
        </div>
      </div>
    </div>
    {/* Arrows appear when the pointer rests near either side (Mac). */}
    {wide && <>
      <button type="button" aria-label={t('folio.readerPrevious')} disabled={page === 0 && part === 0} className="absolute inset-y-0 left-0 flex w-16 items-center justify-center text-[var(--reader-muted)] opacity-0 transition-opacity hover:opacity-100 disabled:hidden" onClick={() => go(page - 1)}><Icon name="arrow-left-s" className="size-9" /></button>
      <button type="button" aria-label={t('folio.readerNext')} disabled={page >= total - 1 && part >= parts.length - 1} className="absolute inset-y-0 right-0 flex w-16 items-center justify-center text-[var(--reader-muted)] opacity-0 transition-opacity hover:opacity-100 disabled:hidden" onClick={() => go(page + 1)}><Icon name="arrow-right-s" className="size-9" /></button>
    </>}
    </div>

    <div className={cn('relative flex h-[calc(env(safe-area-inset-bottom)+64px)] shrink-0 items-start justify-center px-5 pt-3 transition-opacity', !chrome && 'opacity-0')}>
      <button type="button" className={cn(round, 'absolute left-4 top-1')} aria-pressed={Boolean(marked)} aria-label={marked ? t('folio.readerRemoveBookmark') : t('folio.readerAddBookmark')} onClick={toggleMark}>
        {marked ? <Icon name="bookmark-fill" className="size-5 text-[var(--reader-accent)]" /> : <Icon name="bookmark" className="size-5" />}
      </button>
      <span className="pt-2.5 text-[13px] tabular-nums text-[var(--reader-muted)]">{t('folio.readerPageOf', { page: before + page + 1, total: estimated ? `~${overall}` : overall })}</span>
      <button type="button" className={cn(round, 'absolute right-4 top-1')} aria-label={t('folio.readerMenu')} aria-expanded={panel !== 'none'} onClick={() => setPanel(panel === 'none' ? 'menu' : 'none')}>
        <Icon name="list-unordered" className="size-5" />
      </button>
    </div>

    {panel !== 'none' && <div className="absolute bottom-[calc(env(safe-area-inset-bottom)+72px)] right-4 z-10 max-h-[70vh] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl bg-[var(--reader-sheet)] p-2 text-[var(--reader-text)] shadow-2xl"
      onPointerUp={(event) => event.stopPropagation()}>
      {panel === 'menu' && <>
        {allChapters.length > 0 && <button type="button" className={row} onClick={() => setPanel('contents')}><Icon name="list-unordered" className="size-5 text-[var(--reader-muted)]" />{t('folio.readerContents')}</button>}
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
        {allChapters.map((c) => { const local = chapters.indexOf(c); return <button key={c.id} type="button" className={row} onClick={() => jumpTo(c.id)}>
          <span className={cn('min-w-0 flex-1 truncate', c.kind.endsWith('2') && 'pl-3')}>{c.text}</span>
          {local >= 0 && chapterStarts[local] !== undefined && <span className="text-sm tabular-nums text-[var(--reader-muted)]">{before + chapterStarts[local] + 1}</span>}
        </button>; })}
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

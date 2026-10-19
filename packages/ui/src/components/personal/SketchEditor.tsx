import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { SKETCH_PAPER, sketchElementSvg } from '@/lib/personal-workspace/exports';
import { elementHit, translateElement } from '@/lib/personal-workspace/sketch';
import type { SketchElement, WorkspaceArtifact } from '@/lib/personal-workspace/model';

type Drawing = Extract<WorkspaceArtifact, { kind: 'sketch' }>;
type Tool = SketchElement['tool'] | 'erase' | 'move';
const tools = ['pen', 'line', 'rectangle', 'ellipse', 'text', 'erase', 'move'] as const;
// Annotated rather than `satisfies` so scripts/generate-icon-sprite.mjs finds these
// literals and keeps them in the sprite. `satisfies` is invisible to that scanner.
const toolIcons: Record<Tool, IconName> = { pen: 'pencil', line: 'subtract', rectangle: 'checkbox-blank', ellipse: 'checkbox-blank-circle-fill', text: 'text', erase: 'eraser', move: 'drag-move-2' };
// Pigments are document content, not interface theme colors. White leads because
// the paper is dark grey; black stays available for light-background exports.
const pigments = ['#ffffff', '#202020', '#e5484d', '#e9a23b', '#30a46c', '#0091ff', '#8e4ec6'];
const defaultColor = pigments[0];
// A drag shorter than this in both axes is a stray press, not a shape. Dropping
// it is better than an invisible element that still costs an undo step.
const minimumShapeExtent = 3;
// The eraser gets an eraser-shaped pointer instead of a generic crosshair. `#`
// must be percent-encoded or the rest of the data URI parses as a fragment.
const eraserCursor = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28'%3E%3Cg transform='rotate(-45 5 23)'%3E%3Crect x='5' y='19.5' width='16' height='7' rx='2' fill='%23ffffff' stroke='%23202020' stroke-width='1.5'/%3E%3C/g%3E%3C/svg%3E") 5 23, crosshair`;
// Shared empty set: resetting state to the same reference lets React bail out,
// so an idle pointerdown does not force a render.
const noIds: ReadonlySet<string> = new Set();

type Gesture =
  | { kind: 'draw'; pointerId: number; element: SketchElement }
  | { kind: 'move'; pointerId: number; moveId: string; origin: [number, number]; moved: boolean; element: SketchElement }
  | { kind: 'erase'; pointerId: number; removed: Set<string> };

export function SketchEditor({ value, onChange, readOnly = false }: { value: Drawing; onChange: (value: Drawing) => void; readOnly?: boolean }) {
  const { t } = useI18n();
  const [tool, setTool] = React.useState<Tool>('pen');
  const [color, setColor] = React.useState<string>(defaultColor);
  const [width, setWidth] = React.useState(4);
  const [label, setLabel] = React.useState('');
  const [labelNudge, setLabelNudge] = React.useState(false);
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);
  const [movingId, setMovingId] = React.useState<string | null>(null);
  const [erasedIds, setErasedIds] = React.useState<ReadonlySet<string>>(noIds);
  const svgRef = React.useRef<SVGSVGElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const labelRef = React.useRef<HTMLInputElement>(null);
  const previewRef = React.useRef<SVGGElement>(null);
  const nudgeTimer = React.useRef<number | null>(null);
  const gesture = React.useRef<Gesture | null>(null);
  React.useEffect(() => () => { if (nudgeTimer.current !== null) window.clearTimeout(nudgeTimer.current); }, []);
  const pointAt = (event: { clientX: number; clientY: number }): [number, number] => {
    const svg = svgRef.current; const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return [0, 0];
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return [Math.max(0, Math.min(1000, point.x)), Math.max(0, Math.min(650, point.y))];
  };
  const preview = () => {
    // Only sanitized model-generated SVG enters this node, never user HTML.
    const current = gesture.current;
    if (previewRef.current) previewRef.current.innerHTML = current && current.kind !== 'erase' ? sketchElementSvg(current.element) : '';
  };
  const reset = () => { gesture.current = null; preview(); setErasedIds(noIds); setHoveredId(null); setMovingId(null); };
  const capture = (pointerId: number) => {
    // Capture is an enhancement, not a requirement: a synthetic event or a
    // host that refuses capture must never stop the stroke from drawing.
    try { svgRef.current?.setPointerCapture(pointerId); } catch { /* drawing works without capture */ }
  };
  const release = (pointerId: number) => {
    try { svgRef.current?.releasePointerCapture(pointerId); } catch { /* nothing to release */ }
  };
  const hover = (point: [number, number], excluded: ReadonlySet<string> = noIds) => {
    const target = [...value.elements].reverse().find((element) => !excluded.has(element.id) && elementHit(element, point));
    setHoveredId(target?.id ?? null);
  };
  const eraseAt = (point: [number, number]) => {
    const current = gesture.current;
    if (!current || current.kind !== 'erase') return;
    let removed = 0;
    for (const element of value.elements) if (!current.removed.has(element.id) && elementHit(element, point)) { current.removed.add(element.id); removed++; }
    if (removed) setErasedIds(new Set(current.removed));
    hover(point, current.removed);
  };
  const focusLabel = (notice: boolean) => {
    labelRef.current?.focus();
    if (nudgeTimer.current !== null) window.clearTimeout(nudgeTimer.current);
    if (!notice) { nudgeTimer.current = null; setLabelNudge(false); return; }
    // A click with an empty label used to do nothing at all. Flash the field so
    // the press visibly lands somewhere and typing can continue.
    setLabelNudge(true);
    nudgeTimer.current = window.setTimeout(() => { nudgeTimer.current = null; setLabelNudge(false); }, 700);
  };
  const finish = (pointerId: number) => {
    const current = gesture.current;
    if (!current || current.pointerId !== pointerId) return;
    // Clear the gesture before releasing capture: a lost-capture event fired by
    // our own release must not cancel the commit that is about to happen.
    gesture.current = null; preview(); setErasedIds(noIds); setHoveredId(null); setMovingId(null);
    release(pointerId);
    if (current.kind === 'erase') {
      if (current.removed.size) onChange({ ...value, elements: value.elements.filter((element) => !current.removed.has(element.id)) });
      return;
    }
    if (current.kind === 'move') {
      const original = value.elements.find((element) => element.id === current.moveId);
      const moved = Boolean(original && current.moved && original.points.some(([x, y], index) => current.element.points[index]?.[0] !== x || current.element.points[index]?.[1] !== y));
      if (moved && original) onChange({ ...value, elements: value.elements.map((element) => element.id === current.moveId ? current.element : element) });
      return;
    }
    const element = current.element;
    const [startX, startY] = element.points[0]; const [endX, endY] = element.points.at(-1) ?? element.points[0];
    const deliberate = element.tool === 'pen' || Math.max(Math.abs(endX - startX), Math.abs(endY - startY)) > minimumShapeExtent;
    if (deliberate && value.elements.length < 2000) onChange({ ...value, elements: [...value.elements, element] });
  };
  return <div ref={rootRef} tabIndex={-1} className="relative flex min-h-0 flex-1 flex-col overflow-hidden outline-none" data-drawing-canvas>
    <div className="relative min-h-[240px] flex-1 overflow-hidden" style={{ background: SKETCH_PAPER }}>
      <svg ref={svgRef} viewBox="0 0 1000 650" role="img" aria-label={value.title} className="absolute inset-0 h-full w-full touch-none select-none" style={{ cursor: readOnly ? 'default' : tool === 'move' ? 'move' : tool === 'text' ? 'text' : tool === 'erase' ? eraserCursor : 'crosshair' }}
        onPointerDown={(event) => {
          if (readOnly || event.button !== 0) return;
          // Keep the browser from moving focus to the body: the editor decides
          // where focus lands, the canvas (for undo shortcuts) or the label field.
          event.preventDefault();
          reset();
          if (tool !== 'text') rootRef.current?.focus({ preventScroll: true });
          const point = pointAt(event);
          if (tool === 'erase') {
            gesture.current = { kind: 'erase', pointerId: event.pointerId, removed: new Set() };
            capture(event.pointerId); eraseAt(point); return;
          }
          if (tool === 'move') {
            // The topmost hit wins, so overlapping elements move as they appear.
            const existing = [...value.elements].reverse().find((element) => elementHit(element, point));
            if (!existing) return;
            gesture.current = { kind: 'move', pointerId: event.pointerId, moveId: existing.id, origin: point, moved: false, element: existing };
            setMovingId(existing.id); capture(event.pointerId); return;
          }
          if (tool === 'text') {
            if (!label.trim()) { focusLabel(true); return; }
            if (value.elements.length >= 2000) return;
            onChange({ ...value, elements: [...value.elements, { id: crypto.randomUUID(), tool, points: [point], color, width, text: label }] });
            setLabel(''); focusLabel(false); return;
          }
          if (value.elements.length >= 2000) return;
          gesture.current = { kind: 'draw', pointerId: event.pointerId, element: { id: crypto.randomUUID(), tool, points: tool === 'pen' ? [point] : [point, point], color, width, text: '' } };
          capture(event.pointerId); preview();
        }}
        onPointerMove={(event) => {
          if (readOnly) return;
          const current = gesture.current;
          // A second pointer must not feed the active gesture. A move with no
          // primary button means the release happened but its pointerup has not
          // arrived (or was lost) — it carries the last coalesced samples of the
          // drag — so fold it in below and finish: the stroke sticks, drawn work
          // is never discarded, and a gesture whose pointerup never comes still
          // self-heals.
          if (current && current.pointerId !== event.pointerId) return;
          const releasing = Boolean(current && (event.buttons & 1) === 0);
          const point = pointAt(event);
          if (!current) {
            if (tool === 'erase') hover(point);
            return;
          }
          if (current.kind === 'erase') { eraseAt(point); if (releasing) finish(event.pointerId); return; }
          if (current.kind === 'move') {
            current.moved = true;
            const original = value.elements.find((element) => element.id === current.moveId);
            if (original) current.element = translateElement(original, point[0] - current.origin[0], point[1] - current.origin[1]);
            preview(); if (releasing) finish(event.pointerId); return;
          }
          if (current.element.tool === 'pen') {
            const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
            for (const sample of samples.length ? samples : [event]) {
              if (current.element.points.length < 20_000) current.element.points.push(pointAt(sample));
            }
          } else current.element.points = [current.element.points[0], point];
          preview();
          if (releasing) finish(event.pointerId);
        }}
        onPointerUp={(event) => finish(event.pointerId)}
        onPointerCancel={(event) => finish(event.pointerId)}
        onLostPointerCapture={(event) => {
          // Capture can die without a pointerup. Only then is the gesture
          // abandoned: a regular finish releases capture after clearing it, so
          // its lost-capture event lands here as a no-op.
          const current = gesture.current;
          if (current && current.pointerId === event.pointerId) reset();
        }}
        onPointerLeave={() => { if (!gesture.current) setHoveredId(null); }}>
        <rect width="1000" height="650" fill={SKETCH_PAPER} />
        {value.elements.filter((element) => element.id !== movingId && !erasedIds.has(element.id)).map((element) => <g key={element.id} data-element-id={element.id} style={element.id === hoveredId ? { filter: 'drop-shadow(0 0 6px var(--ring))' } : undefined} dangerouslySetInnerHTML={{ __html: sketchElementSvg(element) }} />)}
        <g ref={previewRef} pointerEvents="none" />
      </svg>
    </div>
    {!readOnly && <div className="absolute inset-x-0 bottom-5 flex flex-col items-center gap-2 px-3 pointer-events-none">
      {tool === 'text' && <input ref={labelRef} autoFocus aria-label={t('workspace.text')} placeholder={t('workspace.text')} value={label} maxLength={2000} onChange={(event) => setLabel(event.target.value)} className={`pointer-events-auto w-64 rounded-xl border bg-[var(--surface-elevated)] px-3 py-2 text-foreground shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${labelNudge ? 'ring-2 ring-ring animate-pulse' : ''}`} />}
      <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1 rounded-2xl border bg-[var(--surface-elevated)] p-2 text-foreground shadow-lg" role="group" aria-label={t('workspace.sketch')}>
        {tools.map((item) => <Button key={item} variant="ghost" size="icon" className={`size-10 rounded-xl ${tool === item ? 'bg-interactive-selection text-interactive-selection-foreground' : ''}`} aria-label={t(`workspace.${item}`)} title={t(`workspace.${item}`)} aria-pressed={tool === item} onClick={() => { reset(); setTool(item); }}><Icon name={toolIcons[item]} className="size-5" /></Button>)}
        <span className="mx-1 h-6 border-l" aria-hidden />
        {pigments.map((pigment) => <Button key={pigment} variant="ghost" size="icon" className="size-8 rounded-full" aria-label={`${t('workspace.color')} ${pigment}`} aria-pressed={color === pigment} onClick={() => setColor(pigment)}><span className={`block size-5 rounded-full ${color === pigment ? 'ring-2 ring-ring ring-offset-2 ring-offset-[var(--surface-elevated)]' : ''}`} style={{ background: pigment }} /></Button>)}
        <input type="color" aria-label={t('workspace.color')} title={t('workspace.color')} value={color} onChange={(event) => setColor(event.target.value)} className="size-8 cursor-pointer rounded-full border-0 bg-transparent p-1" />
        <input type="range" aria-label={t('workspace.width')} title={t('workspace.width')} min="1" max="20" value={width} onChange={(event) => setWidth(Number(event.target.value))} className="mx-2 w-16 accent-[var(--interactive-selection-foreground)]" />
      </div>
    </div>}
  </div>;
}

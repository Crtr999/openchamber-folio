import './DirectorOverlay.css';
import React from 'react';
import { createPortal } from 'react-dom';
import { friendColorVariable } from '@/lib/friends';
import { Icon } from '@/components/icon/Icon';
import { useDirectorStore, type DirectorRun } from '@/stores/useDirectorStore';
import { HomeFriendAvatar } from './HomeFriendAvatar';
import { hopPosition, pointOnRoundedRect } from './directorPath';

const FIGURE = 36;
const MARGIN = 20;
const RADIUS = 18;
const SPEED = 0.42;
const SUMMON_MS = 760;
const DELIVER_MS = 560;
const COMPOSE_MS = 650;

type Point = { x: number; y: number };

/** A style object that carries custom properties, which React's own CSSProperties type does not name. */
const withVars = (vars: Record<string, string>): React.CSSProperties => vars;

const composerElement = () => document.querySelector<HTMLElement>('[data-chat-input="true"]');
const sameRect = (a: DOMRect | null, b: DOMRect) => Boolean(a) && a!.left === b.left && a!.top === b.top && a!.width === b.width && a!.height === b.height;

const sourceNames = (used: DirectorRun['used']) => {
  const names: string[] = [];
  if (used?.rules) names.push('Folder rules');
  if (used?.memoryFile) names.push('Memory file');
  if (used && used.entries > 0) names.push(`${used.entries} remembered ${used.entries === 1 ? 'note' : 'notes'}`);
  return names;
};

function DirectorStage({ run }: { run: DirectorRun }) {
  const figureRef = React.useRef<HTMLDivElement>(null);
  const shadowRef = React.useRef<HTMLDivElement>(null);
  const phaseRef = React.useRef(run.phase);
  // Motion runs on a clock that advances at most one slow frame at a time, so a stalled frame
  // (GPU busy as the layers appear) delays the animation instead of skipping it.
  const clockRef = React.useRef(0);
  const phaseStartRef = React.useRef(0);
  const lastPointRef = React.useRef<Point | null>(null);
  const fromRef = React.useRef<Point | null>(null);
  const walkRef = React.useRef(0);
  const originRef = React.useRef<Point | null>(null);
  const [rect, setRect] = React.useState<DOMRect | null>(null);
  const [, setTick] = React.useState(0);
  const [shown, setShown] = React.useState(0);
  const scanStartRef = React.useRef<number | null>(null);
  const reduced = React.useMemo(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, []);

  React.useEffect(() => {
    phaseRef.current = run.phase;
    phaseStartRef.current = clockRef.current;
    fromRef.current = lastPointRef.current;
    if (run.phase === 'scan' && scanStartRef.current === null) scanStartRef.current = clockRef.current;
  }, [run.phase]);

  // The friend leaves from the folder picker's own face, where the person just chose it.
  React.useEffect(() => {
    const face = document.querySelector('[data-director-origin] .oc-friend-avatar')?.getBoundingClientRect();
    if (face && face.width > 0) originRef.current = { x: face.left + face.width / 2, y: face.top + face.height / 2 };
  }, []);

  React.useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 200);
    return () => window.clearInterval(timer);
  }, []);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); useDirectorStore.getState().update(run.id, { skipped: true }); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [run.id]);

  React.useEffect(() => {
    if (!run.improved) { setShown(0); return; }
    const total = run.improved.length;
    const step = Math.max(2, Math.ceil(total / 70));
    setShown(reduced ? total : 0);
    if (reduced) return;
    const timer = window.setInterval(() => setShown((value) => (value >= total ? value : Math.min(total, value + step))), 16);
    return () => window.clearInterval(timer);
  }, [run.improved, reduced]);

  React.useEffect(() => {
    let frameId = 0;
    let lastNow: number | null = null;
    const frame = (now: number) => {
      clockRef.current += lastNow === null ? 0 : Math.min(34, Math.max(0, now - lastNow));
      lastNow = now;
      const element = composerElement();
      const box = element?.getBoundingClientRect();
      const figure = figureRef.current;
      const shadow = shadowRef.current;
      if (box && box.width > 0) {
        setRect((previous) => (sameRect(previous, box) ? previous : box));
        const width = box.width + MARGIN * 2;
        const height = box.height + MARGIN * 2;
        const left = box.left - MARGIN;
        const top = box.top - MARGIN;
        const onPath = (distance: number): Point => {
          const p = pointOnRoundedRect(width, height, RADIUS + MARGIN, distance);
          return { x: left + p.x, y: top + p.y };
        };
        const phase = phaseRef.current;
        const t = clockRef.current - phaseStartRef.current;
        let point: Point;
        let lift = 0;
        let air = 0;
        let scale = 1;
        let opacity = 1;
        let lean = 0;
        if (phase === 'summon') {
          const from = originRef.current ?? { x: box.left + 24, y: box.top - 46 };
          const progress = t / SUMMON_MS;
          point = hopPosition(from, onPath(0), reduced ? 1 : progress, 64);
          air = 256 * Math.min(1, progress) * (1 - Math.min(1, progress));
          const squash = progress < 0.14 ? 1 - progress * 1.3 : progress > 0.86 ? 1 - (1 - progress) * 1.3 : 1;
          scale = squash;
          if (progress >= 1 && !reduced) useDirectorStore.getState().update(run.id, { phase: 'scan' });
          if (reduced) useDirectorStore.getState().update(run.id, { phase: 'scan' });
        } else if (phase === 'scan') {
          const distance = reduced ? 0 : t * SPEED;
          walkRef.current = distance;
          point = onPath(distance);
          const stride = Math.sin(t / 105);
          lift = Math.abs(stride) * 4;
          lean = stride * 5 + (pointOnRoundedRect(width, height, RADIUS + MARGIN, distance).direction === 'right' ? 3 : -3);
        } else if (phase === 'compose') {
          const from = fromRef.current ?? onPath(walkRef.current);
          const target = { x: box.right + MARGIN * 0.5, y: box.top - MARGIN * 0.5 };
          const progress = t / COMPOSE_MS;
          point = hopPosition(from, target, reduced ? 1 : progress, 22);
          air = progress < 1 ? 88 * progress * (1 - progress) : 0;
          lift = progress < 1 ? 0 : Math.abs(Math.sin(t / 300)) * 2;
        } else {
          const from = fromRef.current ?? { x: box.right, y: box.top };
          const target = { x: box.right - 56, y: box.top + box.height / 2 };
          const progress = Math.min(1, t / DELIVER_MS);
          point = hopPosition(from, target, reduced ? 1 : progress, 44);
          air = 176 * progress * (1 - progress);
          scale = 1 - progress * 0.75;
          opacity = 1 - Math.max(0, progress - 0.55) / 0.45;
        }
        lastPointRef.current = point;
        if (figure) {
          figure.style.opacity = String(opacity);
          figure.style.transform = `translate3d(${point.x - FIGURE / 2}px, ${point.y - FIGURE / 2 - lift}px, 0) rotate(${lean}deg) scale(${scale})`;
        }
        if (shadow) {
          const spread = Math.max(0.5, 1 - (lift + air) / 90);
          shadow.style.opacity = String(opacity * 0.9 * spread);
          shadow.style.transform = `translate3d(${point.x - 11}px, ${point.y + 12}px, 0) scale(${spread})`;
        }
      }
      frameId = window.requestAnimationFrame(frame);
    };
    frameId = window.requestAnimationFrame(frame);
    return () => window.cancelAnimationFrame(frameId);
  }, [reduced, run.id]);

  const name = run.friend.name;
  const scanElapsed = scanStartRef.current === null ? 0 : clockRef.current - scanStartRef.current;
  const sources = sourceNames(run.used);
  const step = run.phase === 'summon' ? 'Looking at your message'
    : run.phase === 'scan' ? (scanElapsed < 1000 ? 'Reading your message' : scanElapsed < 2100 ? `Checking ${name}’s memory` : 'Sharpening the prompt')
      : run.phase === 'compose' ? (sources.length ? `Improved with ${sources.join(' · ')}` : 'Improved') : 'Sending to a new chat';
  const done = run.phase === 'compose' || run.phase === 'deliver';
  const box = rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
  const lineCount = box ? Math.max(2, Math.min(6, Math.floor((box.height - 28) / 14))) : 3;

  return (
    <div className="oc-director" data-phase={run.phase} role="status" aria-live="polite" aria-label={`${name} is improving your message`}
      style={withVars({ '--director-accent': friendColorVariable(run.friend.color) })}>
      {box && (run.phase === 'summon' || run.phase === 'scan') && (
        <div className="oc-director-veil" style={{ ...box, ...withVars({ '--director-sweep': `${Math.max(0, box.width - 84)}px` }) }}>
          <div className="oc-director-lines" aria-hidden="true">
            {Array.from({ length: lineCount }, (_, index) => <i key={index} style={{ width: `${88 - ((index * 23) % 46)}%`, animationDelay: `${index * 0.13}s` }} />)}
          </div>
          <div className="oc-director-beam" />
        </div>
      )}
      {box && <div className="oc-director-frame" style={box} />}
      {box && run.improved && (run.phase === 'compose' || run.phase === 'deliver') && (
        <div className="oc-director-result" style={box}>
          <div className="oc-director-result-head">
            <b>{name}</b><span>Director</span>
            {sources.map((source) => <span key={source} className="oc-director-source">{source}</span>)}
          </div>
          <div className="oc-director-result-text">{run.improved.slice(0, shown)}{shown < run.improved.length && <span className="oc-director-caret" />}</div>
        </div>
      )}
      {box && (
        <div className="oc-director-chip" style={{ left: box.left + box.width / 2, top: box.top + box.height + 14, transform: 'translateX(-50%)' }}>
          {done ? <Icon name="check" className="oc-director-check" /> : <span className="oc-director-spin" aria-hidden="true" />}
          <span className="oc-director-chip-label">Director</span>
          <span className="oc-director-chip-step" data-done={run.phase === 'compose' ? 'true' : undefined}>{step}</span>
          {run.phase !== 'deliver' && (
            <button type="button" className="oc-director-skip" onClick={() => useDirectorStore.getState().update(run.id, { skipped: true })}>Send as written · Esc</button>
          )}
        </div>
      )}
      <div ref={shadowRef} className="oc-director-shadow" aria-hidden="true" style={{ opacity: 0 }} />
      <div ref={figureRef} className="oc-director-figure" aria-hidden="true" style={{ opacity: 0 }}>
        <span className="oc-friend-activity" data-working="true" style={{ display: 'block', width: '100%', height: '100%' }}>
          <HomeFriendAvatar body={run.friend.body} color={run.friend.color} />
        </span>
      </div>
    </div>
  );
}

/** Mounts once with the composer: while the Director is working it floats the friend above the page. */
export function DirectorOverlay() {
  const run = useDirectorStore((state) => state.run);
  if (!run) return null;
  return createPortal(<DirectorStage key={run.id} run={run} />, document.body);
}

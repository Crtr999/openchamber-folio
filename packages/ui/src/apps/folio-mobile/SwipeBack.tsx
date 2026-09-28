import React from 'react';
import { cn } from '@/lib/utils';

const EDGE = 28; // px from the left edge where the swipe must begin
const ENGAGE = 8; // px of rightward travel before the pane starts following the finger

/**
 * A screen stacked over Home. Dragging from the left edge slides it off to the right with the finger,
 * revealing Home underneath, like every iPhone app; letting go past a third of the width (or with a
 * flick) finishes going Home, otherwise it springs back.
 *
 * Listeners run in the capture phase so the gesture wins over whatever is inside (editors, the chat's
 * own edge swipes), but nothing is claimed until the finger has clearly moved right from the edge, so
 * taps and vertical scrolling near the edge behave normally.
 */
export function SwipeBackPane({ onBack, onPeek, hidden, className, children }: {
  onBack: () => void;
  /** Called with true when a swipe starts (Home should be drawn underneath) and false when it springs back. */
  onPeek?: (peeking: boolean) => void;
  hidden?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const callbacks = React.useRef({ onBack, onPeek });
  callbacks.current = { onBack, onPeek };

  React.useEffect(() => {
    const element = ref.current;
    if (!element || hidden) return;
    let startX = 0, startY = 0, lastX = 0, lastT = 0, velocity = 0;
    let state: 'idle' | 'pending' | 'dragging' = 'idle';

    const setX = (x: number, animate: boolean) => {
      element.style.transition = animate ? 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none';
      element.style.transform = x ? `translate3d(${x}px,0,0)` : '';
    };
    const start = (event: TouchEvent) => {
      state = 'idle';
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (touch.clientX > EDGE) return;
      state = 'pending';
      startX = lastX = touch.clientX; startY = touch.clientY; lastT = event.timeStamp; velocity = 0;
    };
    const move = (event: TouchEvent) => {
      if (state === 'idle') return;
      const touch = event.touches[0];
      if (!touch) return;
      const dx = touch.clientX - startX, dy = touch.clientY - startY;
      if (state === 'pending') {
        if (Math.abs(dy) > 10 && Math.abs(dy) > dx) { state = 'idle'; return; }
        if (dx < ENGAGE || dx < Math.abs(dy)) return;
        state = 'dragging';
        // Leaving this screen: put the keyboard away and drop any text selection the touch began.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        window.getSelection()?.removeAllRanges();
        element.style.boxShadow = '-8px 0 24px rgba(0,0,0,0.25)';
        callbacks.current.onPeek?.(true);
      }
      event.preventDefault();
      event.stopPropagation();
      const dt = Math.max(1, event.timeStamp - lastT);
      velocity = 0.7 * velocity + 0.3 * ((touch.clientX - lastX) / dt);
      lastX = touch.clientX; lastT = event.timeStamp;
      setX(Math.max(0, dx), false);
    };
    const end = (event: TouchEvent) => {
      if (state !== 'dragging') { state = 'idle'; return; }
      state = 'idle';
      event.stopPropagation();
      const width = element.clientWidth || window.innerWidth;
      const travelled = lastX - startX;
      if (travelled > width / 3 || (velocity > 0.45 && travelled > 40)) {
        setX(width, true);
        window.setTimeout(() => {
          callbacks.current.onBack();
          // The pane is usually unmounted by now; if it stays (the chats), reset it for next time.
          element.style.transition = 'none'; element.style.transform = ''; element.style.boxShadow = '';
        }, 200);
      } else {
        setX(0, true);
        window.setTimeout(() => { element.style.boxShadow = ''; callbacks.current.onPeek?.(false); }, 220);
      }
    };
    const cancel = () => {
      if (state === 'dragging') { setX(0, true); element.style.boxShadow = ''; callbacks.current.onPeek?.(false); }
      state = 'idle';
    };
    element.addEventListener('touchstart', start, { capture: true, passive: true });
    element.addEventListener('touchmove', move, { capture: true, passive: false });
    element.addEventListener('touchend', end, { capture: true });
    element.addEventListener('touchcancel', cancel, { capture: true });
    return () => {
      element.removeEventListener('touchstart', start, { capture: true });
      element.removeEventListener('touchmove', move, { capture: true });
      element.removeEventListener('touchend', end, { capture: true });
      element.removeEventListener('touchcancel', cancel, { capture: true });
    };
  }, [hidden]);

  // No will-change-transform: it promoted the pane to its own compositing layer for as long as it
  // was mounted, and iOS clips composited layers to the safe-area viewport. Every other pane sits
  // inside a container already inset by the top safe area, so only the chats pane — the one that
  // spans the full screen — could have the strip above it left unpainted. The drag sets translate3d
  // inline, so the pane still gets its layer while the gesture is actually running.
  return <div ref={ref} className={cn('absolute inset-0 flex flex-col bg-background', hidden && 'hidden', className)}>{children}</div>;
}

/**
 * Small Web Animations helpers for Open Carter's "one surface that reshapes"
 * motion: a panel grows out of the control that opened it, reshapes when its
 * content changes, and collapses into a pill when it is done. Everything is a
 * no-op when the Mac asks for reduced motion.
 */
export const prefersReducedMotion = (): boolean => {
    try { return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches); } catch { return false; }
};

const SPRING = 'cubic-bezier(0.2, 0.9, 0.25, 1.08)';
const EASE_IN = 'cubic-bezier(0.4, 0, 0.7, 0.2)';

const deltaTransform = (from: DOMRect, to: DOMRect) => {
    const scaleX = Math.max(0.05, from.width / Math.max(1, to.width));
    const scaleY = Math.max(0.05, from.height / Math.max(1, to.height));
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    return `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`;
};

/** Grow `element` out of `from` (a control's rect) into its natural place. */
export const morphFrom = (element: HTMLElement | null, from: DOMRect | null, duration = 340): Animation | null => {
    if (!element?.animate || !from || prefersReducedMotion()) return null;
    const to = element.getBoundingClientRect();
    if (!to.width || !to.height) return null;
    return element.animate([
        { transform: deltaTransform(from, to), opacity: 0.2, borderRadius: '999px', filter: 'blur(6px)' },
        { opacity: 1, offset: 0.45, filter: 'blur(0px)' },
        { transform: 'none', opacity: 1, borderRadius: getComputedStyle(element).borderRadius },
    ], { duration, easing: SPRING });
};

/** Shrink `element` into `to` (a pill or control), then resolve. */
export const morphInto = async (element: HTMLElement | null, to: DOMRect | null, duration = 220): Promise<void> => {
    if (!element?.animate || !to || prefersReducedMotion()) return;
    const from = element.getBoundingClientRect();
    const animation = element.animate([
        { transform: 'none', opacity: 1 },
        { transform: deltaTransform(to, from), opacity: 0, borderRadius: '999px', filter: 'blur(4px)' },
    ], { duration, easing: EASE_IN, fill: 'forwards' });
    try { await animation.finished; } catch { /* cancelled */ }
};

/** Collapse a panel into a small pill in its own center and fade it away. */
export const collapseAway = async (element: HTMLElement | null, duration = 260): Promise<void> => {
    if (!element?.animate || prefersReducedMotion()) return;
    const rect = element.getBoundingClientRect();
    const pill = new DOMRect(rect.left + rect.width / 2 - 70, rect.top + rect.height / 2 - 14, 140, 28);
    await morphInto(element, pill, duration);
};

/** Reshape smoothly after content changed size: call with the rect from before the change. */
export const reshapeFrom = (element: HTMLElement | null, before: DOMRect | null, duration = 300): Animation | null => {
    if (!element?.animate || !before || prefersReducedMotion()) return null;
    const after = element.getBoundingClientRect();
    if (Math.abs(after.width - before.width) < 2 && Math.abs(after.height - before.height) < 2) return null;
    // Clip from the old outline to the new one so the content never stretches.
    const grow = after.width >= before.width && after.height >= before.height;
    if (grow) {
        const insetX = Math.max(0, (after.width - before.width) / 2);
        const insetBottom = Math.max(0, after.height - before.height);
        return element.animate([
            { clipPath: `inset(0px ${insetX}px ${insetBottom}px ${insetX}px round 14px)` },
            { clipPath: 'inset(0px 0px 0px 0px round 14px)' },
        ], { duration, easing: SPRING });
    }
    return element.animate([
        { transform: `scale(${before.width / after.width}, ${before.height / after.height})`, opacity: 0.85 },
        { transform: 'none', opacity: 1 },
    ], { duration: Math.round(duration * 0.8), easing: SPRING });
};

/** Bottom-center pill rectangle, where the meeting pill and confirmations live. */
export const bottomPillRect = (width = 260, height = 40): DOMRect =>
    new DOMRect(window.innerWidth / 2 - width / 2, window.innerHeight - 20 - height, width, height);

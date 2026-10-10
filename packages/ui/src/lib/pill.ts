/** Fire a small confirmation pill (bottom center) that pops in and collapses away. */
export type PillTone = 'success' | 'info' | 'error';
export const PILL_EVENT = 'open-carter:pill';
export const showPill = (text: string, tone: PillTone = 'success') => {
    window.dispatchEvent(new CustomEvent(PILL_EVENT, { detail: { text, tone } }));
};

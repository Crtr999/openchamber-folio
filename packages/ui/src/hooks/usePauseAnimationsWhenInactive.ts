import React from 'react';

/** The root attribute the stylesheet reads to freeze decorative motion. */
export const INACTIVE_ATTRIBUTE = 'data-oc-inactive';

/**
 * Marks the document inactive while the window is hidden or not focused, so purely decorative
 * animations (friend faces, status pulses, the Home scene) stop asking the compositor for a new
 * frame that nobody is looking at. Functional spinners keep running; see open-carter-vibe.css.
 */
export const usePauseAnimationsWhenInactive = (): void => {
  React.useEffect(() => {
    const root = document.documentElement;
    const sync = () => {
      const inactive = document.visibilityState === 'hidden' || !document.hasFocus();
      if (inactive) root.setAttribute(INACTIVE_ATTRIBUTE, 'true');
      else root.removeAttribute(INACTIVE_ATTRIBUTE);
    };
    sync();
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
      document.removeEventListener('visibilitychange', sync);
      root.removeAttribute(INACTIVE_ATTRIBUTE);
    };
  }, []);
};

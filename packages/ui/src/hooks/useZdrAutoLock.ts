import React from 'react';
import { AUTO_LOCK_AFTER_MS, useZdrLockStore } from '@/stores/useZdrLockStore';
import { subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';

/** Loads the lock's state and locks again after the window has been away for a while. */
export const useZdrAutoLock = (): void => {
  React.useEffect(() => {
    void useZdrLockStore.getState().refresh();
    let leftAt: number | null = document.visibilityState === 'hidden' || !document.hasFocus() ? Date.now() : null;
    const away = () => { if (leftAt === null) leftAt = Date.now(); };
    const back = () => {
      if (leftAt !== null && Date.now() - leftAt >= AUTO_LOCK_AFTER_MS) useZdrLockStore.getState().lock();
      leftAt = null;
      void useZdrLockStore.getState().refresh();
    };
    const onVisibility = () => (document.visibilityState === 'hidden' ? away() : back());
    window.addEventListener('blur', away);
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', onVisibility);
    const beforeSwitch = subscribeRuntimeEndpointWillChange(() => useZdrLockStore.getState().reset());
    const afterSwitch = subscribeRuntimeEndpointChanged(() => { void useZdrLockStore.getState().refresh(); });
    return () => {
      window.removeEventListener('blur', away);
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', onVisibility);
      beforeSwitch();
      afterSwitch();
    };
  }, []);
};

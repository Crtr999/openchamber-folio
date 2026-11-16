export const DEFAULT_SUMMON_ACCELERATOR = 'CommandOrControl+Shift+Space';

// Own only this registration. Tray, menu and renderer shortcuts have separate
// lifetimes and must not be removed when the summon shortcut stops.
export const createSummonShortcut = ({
  globalShortcut,
  getWindow,
  revealWindow,
  beforeHide,
  canToggle,
  onUnavailable,
  onError,
}) => {
  let registered = false;
  let toggling = false;
  let registrationId = 0;

  const toggle = async () => {
    if (!registered || toggling || !canToggle()) return;
    toggling = true;
    const id = registrationId;
    const shouldReveal = () => registered && id === registrationId && canToggle();
    try {
      const target = getWindow();
      if (target && !target.isDestroyed() && target.isVisible() && !target.isMinimized() && target.isFocused()) {
        beforeHide(target);
        target.hide();
      } else {
        // The existing reveal path restores geometry and never navigates a
        // live window. Coalesce presses while it recreates a closed window.
        await revealWindow(shouldReveal);
      }
    } catch (error) {
      onError(error);
    } finally {
      toggling = false;
    }
  };

  return {
    start() {
      if (registered) return true;
      // An existing registration in this process is not ours to replace.
      try {
        if (!globalShortcut.isRegistered(DEFAULT_SUMMON_ACCELERATOR)) {
          registered = globalShortcut.register(DEFAULT_SUMMON_ACCELERATOR, toggle);
        }
      } catch {
        registered = false;
      }
      if (!registered) onUnavailable(DEFAULT_SUMMON_ACCELERATOR);
      return registered;
    },
    stop() {
      if (!registered) return;
      registered = false;
      registrationId += 1;
      globalShortcut.unregister(DEFAULT_SUMMON_ACCELERATOR);
    },
  };
};

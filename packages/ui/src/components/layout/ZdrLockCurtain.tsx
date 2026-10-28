import './ZdrLock.css';
import React from 'react';
import { createPortal } from 'react-dom';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useZdrLockStore } from '@/stores/useZdrLockStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { ZdrPinEntry } from './ZdrPinEntry';

/**
 * Covers the window whenever the view is inside a ZDR folder and the PIN has not been entered.
 * One place guards every way in: the sidebar, tabs, search, restore on launch and the folder picker.
 */
export function ZdrLockCurtain() {
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const draftDirectory = useSessionUIStore((state) => state.newSessionDraft?.open ? state.newSessionDraft.directoryOverride ?? null : null);
  const draftProjectId = useSessionUIStore((state) => state.newSessionDraft?.open ? state.newSessionDraft.selectedProjectId ?? null : null);
  const draftProjectPath = useProjectsStore((state) => draftProjectId ? state.projects.find((entry) => entry.id === draftProjectId)?.path ?? null : null);
  const locked = useZdrLockStore((state) => state.isLocked(currentDirectory) || state.isLocked(draftDirectory) || state.isLocked(draftProjectPath));
  const unlock = useZdrLockStore((state) => state.unlock);

  const leave = React.useCallback(() => {
    const sessions = useSessionUIStore.getState();
    sessions.setCurrentSession(null);
    sessions.openNewSessionDraft({ target: 'chat' });
  }, []);

  if (!locked) return null;
  return createPortal(
    <div className="oc-zdr-curtain" role="dialog" aria-modal="true" aria-label="ZDR folder locked">
      <ZdrPinEntry title="ZDR folder locked" hint="Enter your four-digit PIN." onSubmit={unlock} onCancel={leave} cancelLabel="Back to Home" />
    </div>,
    document.body,
  );
}

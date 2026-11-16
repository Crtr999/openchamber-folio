import React from 'react';
import type { PermissionReply, PermissionRequest } from '@/types/permission';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessions } from '@/sync/sync-context';
import * as sessionActions from '@/sync/session-actions';
import { getPermissionReply } from '@/sync/permission-replies';
import { getSyncChildStores } from '@/sync/sync-refs';
import { getRuntimeKey } from '@/lib/runtime-switch';

// Newest pending card owns the keyboard; older cards wait their turn.
const activePermissionCards: symbol[] = [];

/** The request was raised by a child of the session the user is looking at. */
export const usePermissionFromSubagent = (permission: PermissionRequest): boolean => {
  const sessions = useSessions();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  return React.useMemo(() => {
    if (!currentSessionId || permission.sessionID === currentSessionId) return false;
    const sourceSession = sessions.find((session) => session.id === permission.sessionID);
    return Boolean(sourceSession?.parentID && sourceSession.parentID === currentSessionId);
  }, [permission.sessionID, currentSessionId, sessions]);
};

/**
 * Replies to one request and owns its keyboard shortcuts while it is the
 * newest pending one: Alt+Enter allows once, Alt+Shift+Enter always,
 * Alt+Backspace denies. Shared by the inline card and the dock.
 */
export const usePermissionResponse = (
  permission: PermissionRequest,
  onResponse?: (response: PermissionReply) => void,
  shortcutsEnabled = true,
) => {
  const manager = getSyncChildStores();
  const reply = React.useMemo(() => {
    const runtimeKey = getRuntimeKey();
    return getPermissionReply(manager, runtimeKey, permission.sessionID, permission.id,
      (response) => sessionActions.respondToPermission(permission.sessionID, permission.id, response, undefined, runtimeKey),
    );
  }, [manager, permission.id, permission.sessionID]);
  const state = React.useSyncExternalStore(reply.subscribe, reply.getSnapshot, reply.getSnapshot);
  const isResponding = state === 'pending';
  const hasResponded = state === 'settled';

  const respond = React.useCallback(async (response: PermissionReply) => {
    if (await reply.respond(response)) {
      onResponse?.(response);
    }
  }, [onResponse, reply]);

  const respondRef = React.useRef(respond);
  respondRef.current = respond;

  React.useEffect(() => {
    if (hasResponded || !shortcutsEnabled) return;
    const owner = Symbol('permission-shortcuts');
    activePermissionCards.push(owner);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (activePermissionCards.at(-1) !== owner || document.hidden) return;
      if (event.repeat || event.isComposing || event.defaultPrevented) return;
      if (!event.altKey || event.metaKey || event.ctrlKey) return;
      const response = event.key === 'Enter'
        ? (event.shiftKey ? 'always' as const : 'once' as const)
        : event.key === 'Backspace' && !event.shiftKey
          ? 'reject' as const
          : null;
      if (!response) return;
      event.preventDefault();
      event.stopPropagation();
      void respondRef.current(response);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      const index = activePermissionCards.lastIndexOf(owner);
      if (index !== -1) activePermissionCards.splice(index, 1);
    };
  }, [hasResponded, permission.id, shortcutsEnabled]);

  return { isResponding, hasResponded, hasError: state === 'failed', respond };
};

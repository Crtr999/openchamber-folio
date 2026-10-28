import React from 'react';
import type { ChildStoreManager } from '@/sync/child-store';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { normalizePath } from '../utils';
import type { SessionGroup } from '../types';
import type { ProjectSection } from '../projects/sessionProjectRender';
import { getSessionFolderScopes } from '../sessions/sessionFolderIdentity';
import type { SessionSidebarGroupStatus } from '../sessionSidebarRowModel';

// A runtime that was still starting, or briefly restarted, fails a directory's
// bootstrap or initialization. Those failures are transient, so they retry on
// their own with backoff instead of waiting for someone to press Retry. OS
// permission failures never retry: only the person can grant that access.
const AUTO_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
// A failure this long after the last retry is a new outage, not the same one.
const AUTO_RETRY_RESET_MS = 5 * 60_000;

const useAutoRetryFailedDirectories = (
  childStores: ChildStoreManager,
  statuses: ReadonlyMap<string, SessionSidebarGroupStatus>,
) => {
  const attemptsRef = React.useRef(new Map<string, { count: number; at: number }>());
  const failedKey = React.useMemo(() => [...new Set(
    [...statuses.values()]
      .filter((status) => (status.state === 'load-failed' || status.state === 'initialization-failed') && status.directory)
      .map((status) => status.directory as string),
  )].sort().join('\u0001'), [statuses]);

  React.useEffect(() => {
    const failed = failedKey ? failedKey.split('\u0001') : [];
    const attempts = attemptsRef.current;
    const timers = failed.flatMap((directory) => {
      const previous = attempts.get(directory);
      const attempt = previous && Date.now() - previous.at < AUTO_RETRY_RESET_MS ? previous.count : 0;
      const delay = AUTO_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) return [];
      return [window.setTimeout(() => {
        attempts.set(directory, { count: attempt + 1, at: Date.now() });
        childStores.requestBootstrap({ directory, priority: 'background', reason: 'action-demand', force: true });
      }, delay)];
    });
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [childStores, failedKey]);
};

export const useSidebarGroupStatus = ({
  childStores,
  sections,
  chatGroup,
  canGrantAccess,
}: {
  childStores: ChildStoreManager;
  sections: readonly ProjectSection[];
  chatGroup: SessionGroup | null;
  canGrantAccess: boolean;
}) => {
  const globalStatus = useGlobalSessionsStore((state) => state.status);
  const hasLoadedGlobalSessions = useGlobalSessionsStore((state) => state.hasLoaded);
  const groups = React.useMemo(() => [
    ...sections.flatMap((section) => section.groups.map((group) => ({ key: `${section.project.id}:${group.id}`, group }))),
    ...(chatGroup ? [{ key: 'activity:chats', group: chatGroup }] : []),
  ].map(({ key, group }) => ({
    key,
    archived: group.isArchivedBucket === true,
    directories: getSessionFolderScopes(group).map((scope) => normalizePath(scope.directory))
      .filter((directory): directory is string => Boolean(directory)),
  })), [chatGroup, sections]);
  const directories = React.useMemo(() => [...new Set(groups.flatMap((group) => group.directories))], [groups]);
  const bootstrapSnapshot = React.useSyncExternalStore(
    React.useCallback((notify) => directories.length > 0 ? childStores.subscribeBootstrap(notify) : () => undefined, [childStores, directories.length]),
    React.useCallback(() => directories.map((directory) => (
      `${directory}\u0000${childStores.getBootstrapState(directory) ?? ''}\u0000${childStores.getBootstrapFailure(directory) ?? ''}\u0000${childStores.getInitializationState(directory) ?? ''}\u0000${childStores.getInitializationFailure(directory) ?? ''}`
    )).join('\u0001'), [childStores, directories]),
    React.useCallback(() => '', []),
  );
  const groupStatusByKey = React.useMemo(() => {
    // The snapshot invalidates these reads; the directory stores own their state.
    void bootstrapSnapshot;
    const statuses = new Map<string, SessionSidebarGroupStatus>();
    for (const { key, archived, directories: groupDirectories } of groups) {
      const failedDirectory = groupDirectories.find((directory) => (
        childStores.getBootstrapState(directory) === 'failed' || childStores.getInitializationState(directory) === 'failed'
      ));
      if (failedDirectory) {
        const listFailed = childStores.getBootstrapState(failedDirectory) === 'failed';
        const failure = listFailed ? childStores.getBootstrapFailure(failedDirectory) : childStores.getInitializationFailure(failedDirectory);
        statuses.set(key, {
          state: failure === 'os-permission' ? 'permission-denied' : listFailed ? 'load-failed' : 'initialization-failed',
          directory: failedDirectory,
          canGrantAccess: failure === 'os-permission' && canGrantAccess,
        });
      } else {
        // Unopened directories rely on the global list. A previous complete
        // list keeps empty groups ready during background refreshes.
        const complete = hasLoadedGlobalSessions || (!archived && groupDirectories.length > 0
          && groupDirectories.every((directory) => childStores.getBootstrapState(directory) === 'complete'));
        statuses.set(key, {
          state: complete ? 'ready' : globalStatus === 'error' ? 'load-failed' : 'loading',
          // A null directory retries the global list, without initializing a location.
          directory: complete ? groupDirectories[0] ?? null : null,
          canGrantAccess: false,
        });
      }
    }
    return statuses;
  }, [bootstrapSnapshot, canGrantAccess, childStores, groups, globalStatus, hasLoadedGlobalSessions]);
  useAutoRetryFailedDirectories(childStores, groupStatusByKey);
  return { groupStatusByKey, bootstrapSnapshot };
};

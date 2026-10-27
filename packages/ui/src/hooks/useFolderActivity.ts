import { useMemo } from 'react';

import { normalizeProjectPath } from '@/lib/projectResolution';
import { normalizeFolderKeyPath } from '@/lib/friends';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';

export type FolderActivity = {
  /** A conversation in this folder is working right now. */
  working: boolean;
  /** How many conversations in this folder are working. */
  workingCount: number;
  /** One of them is retrying, so this folder wants attention rather than patience. */
  retrying: boolean;
  waiting: boolean;
};

const IDLE: FolderActivity = { working: false, workingCount: 0, retrying: false, waiting: false };

/**
 * What a folder is doing right now.
 *
 * A friend is a folder, and a folder is busy when any conversation in it is
 * busy. The shared live status index already carries each active session's
 * directory, so this is a read of one store rather than a scan of every
 * session in every folder.
 *
 * The directory is matched the way the rest of the app matches it — canonical
 * path, so a trailing slash or a symlinked spelling of the same folder is the
 * same folder. A nested folder is its own folder, exactly as the friend
 * widgets treat it.
 *
 * All Chats is the one exception: it is not a folder but the area above every
 * folder, and each of its conversations lives in a dated directory underneath
 * it. So it asks for `includeNested`, and its conversations are found by being
 * under the root rather than at it.
 */
export const useFolderActivity = (
  directory?: string | null,
  options?: { includeNested?: boolean },
): FolderActivity => {
  const statusById = useGlobalSessionStatusStore((state) => state.statusById);
  const pending = useGlobalBlockingRequestsStore(state => state.bySession);
  const includeNested = options?.includeNested === true;
  return useMemo(() => {
    const scope = normalizeProjectPath(directory ?? '');
    if (!scope) return IDLE;
    const nestedPrefix = includeNested ? `${normalizeFolderKeyPath(scope).replace(/\/+$/, '')}/` : null;
    const belongs = (raw: string) => {
      const normalized = normalizeProjectPath(raw);
      return normalized === scope || Boolean(nestedPrefix && normalizeFolderKeyPath(normalized ?? '').startsWith(nestedPrefix));
    };
    let workingCount = 0;
    let waiting = false;
    let retrying = false;
    for (const request of pending.values()) {
      if (belongs(request.directory) && (request.permissions.length || request.forms.length)) { waiting = true; break; }
    }
    for (const [sessionId, entry] of statusById) {
      const entryDirectory = normalizeProjectPath(entry.directory);
      if (entryDirectory !== scope) {
        if (!nestedPrefix) continue;
        if (!normalizeFolderKeyPath(entryDirectory ?? '').startsWith(nestedPrefix)) continue;
      }
      const request = pending.get(sessionId);
      if (request && (request.permissions.length || request.forms.length)) { waiting = true; continue; }
      if (entry.status.type === 'retry') {
        retrying = true;
        workingCount += 1;
        continue;
      }
      if (entry.status.type === 'busy') workingCount += 1;
    }
    return { working: workingCount > 0, workingCount, retrying, waiting };
  }, [statusById, pending, directory, includeNested]);
};

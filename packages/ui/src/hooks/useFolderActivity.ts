import { useMemo } from 'react';

import { normalizeProjectPath } from '@/lib/projectResolution';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';

export type FolderActivity = {
  /** A conversation in this folder is working right now. */
  working: boolean;
  /** How many conversations in this folder are working. */
  workingCount: number;
  /** One of them is retrying, so this folder wants attention rather than patience. */
  retrying: boolean;
};

const IDLE: FolderActivity = { working: false, workingCount: 0, retrying: false };

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
 */
export const useFolderActivity = (directory?: string | null): FolderActivity => {
  const statusById = useGlobalSessionStatusStore((state) => state.statusById);
  return useMemo(() => {
    const scope = normalizeProjectPath(directory ?? '');
    if (!scope) return IDLE;
    let workingCount = 0;
    let retrying = false;
    for (const entry of statusById.values()) {
      if (normalizeProjectPath(entry.directory) !== scope) continue;
      if (entry.status.type === 'retry') {
        retrying = true;
        workingCount += 1;
        continue;
      }
      if (entry.status.type === 'busy') workingCount += 1;
    }
    return { working: workingCount > 0, workingCount, retrying };
  }, [statusById, directory]);
};

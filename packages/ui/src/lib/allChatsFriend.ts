import type { ProjectEntry } from '@/lib/api/types';
import { normalizeFolderKeyPath } from '@/lib/friends';

/**
 * All Chats is a friend too.
 *
 * A conversation that belongs to no folder still belongs to somebody: it runs
 * in a dated directory under the app's own chats root, and everything the user
 * says in those conversations is about the user, not about a folder. Treating
 * that area as a friend gives it a name, a face, and — the point of it — a
 * memory of its own that is kept apart from every folder's.
 *
 * The chats root is not a project the user configured, so it never appears in
 * the project store. The friend is synthesised from the root the server
 * reports, and it is the only Friend whose conversations live *below* its
 * path rather than in it: each conversation gets its own dated directory, so
 * membership is "under the root", not "is the root".
 */

export const ALL_CHATS_PROJECT_ID = 'openchamber:chats';

/** The friend identity of the All Chats area, built from the chats root. */
export const allChatsProject = (chatsRoot: string | null | undefined): ProjectEntry | null => {
  const path = typeof chatsRoot === 'string' ? chatsRoot.trim() : '';
  if (!path) return null;
  return { id: ALL_CHATS_PROJECT_ID, path, label: 'General' } as ProjectEntry;
};

export const isAllChatsProject = (project: { id: string } | null | undefined): boolean =>
  project?.id === ALL_CHATS_PROJECT_ID;

/** True when a directory sits inside the chats root rather than being it. */
export const isWithinChatsRoot = (directory: string | null | undefined, chatsRoot: string | null | undefined): boolean => {
  const dir = typeof directory === 'string' ? directory.trim() : '';
  const root = typeof chatsRoot === 'string' ? chatsRoot.trim() : '';
  if (!dir || !root) return false;
  const normalizedDir = normalizeFolderKeyPath(dir);
  const normalizedRoot = normalizeFolderKeyPath(root);
  return normalizedDir === normalizedRoot || normalizedDir.startsWith(`${normalizedRoot}/`);
};

/**
 * Whether a conversation belongs to a friend.
 *
 * A folder friend owns exactly its own path: a nested folder is a different
 * friend, and its conversations are not this one's. All Chats is the
 * exception, because its conversations are dated directories underneath it.
 */
export const sessionBelongsToFriend = (
  project: { id: string; path: string },
  session: { directory?: string | null },
): boolean => {
  if (!session?.directory) return false;
  if (isAllChatsProject(project)) return isWithinChatsRoot(session.directory, project.path);
  return normalizeFolderKeyPath(session.directory) === normalizeFolderKeyPath(project.path);
};

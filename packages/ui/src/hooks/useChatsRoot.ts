import React from 'react';

import { opencodeClient } from '@/lib/opencode/client';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeKey } from '@/lib/runtime-switch';

/**
 * The chats root, as the server reports it.
 *
 * Every conversation that belongs to no folder lives under it, in a dated
 * directory of its own. The root is what makes that area one friend rather
 * than a pile of folders, so it is asked of the server once per runtime and
 * then kept.
 */

const rootsByRuntime = new Map<string, string | null>();
const pendingByRuntime = new Map<string, Promise<string | null>>();

const resolveChatsRoot = async (runtimeKey: string): Promise<string | null> => {
  try {
    const info = await opencodeClient.getFilesystemHomeInfo();
    const root = normalizePath(info.chatsRoot);
    rootsByRuntime.set(runtimeKey, root);
    return root;
  } catch {
    rootsByRuntime.set(runtimeKey, null);
    return null;
  }
};

export const readChatsRoot = (): string | null => rootsByRuntime.get(getRuntimeKey()) ?? null;

/** The root, fetched once per runtime. Returns null until it is known. */
export const useChatsRoot = (): string | null => {
  const [chatsRoot, setChatsRoot] = React.useState<string | null>(() => readChatsRoot());
  React.useEffect(() => {
    let alive = true;
    const runtimeKey = getRuntimeKey();
    const existing = pendingByRuntime.get(runtimeKey);
    if (existing) {
      void existing.then((root) => { if (alive) setChatsRoot(root); });
      return () => { alive = false; };
    }
    const promise = resolveChatsRoot(runtimeKey);
    pendingByRuntime.set(runtimeKey, promise);
    void promise.then((root) => { if (alive) setChatsRoot(root); }).finally(() => {
      if (pendingByRuntime.get(runtimeKey) === promise) pendingByRuntime.delete(runtimeKey);
    });
    return () => { alive = false; };
  }, []);
  return chatsRoot;
};

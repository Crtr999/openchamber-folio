import type { PermissionReply } from '@/types/permission';
import type { ChildStoreManager } from './child-store';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';

type ReplyState = 'idle' | 'pending' | 'failed' | 'settled';

/** One authoritative request owns one reply, independently of mounted presentations. */
export function createPermissionReply(submit: (response: PermissionReply) => Promise<void>) {
  let state: ReplyState = 'idle';
  let removed = false;
  const listeners = new Set<() => void>();
  const publish = (next: ReplyState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  return {
    getSnapshot: () => state,
    retire: () => {
      removed = true;
      if (state !== 'pending') publish('settled');
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async respond(response: PermissionReply): Promise<boolean> {
      // Lock before awaiting or publishing a React render, including held keyboard shortcuts.
      if (removed || state === 'pending' || state === 'settled') return false;
      publish('pending');
      try {
        await submit(response);
      } catch {
        publish(removed ? 'settled' : 'failed');
        return false;
      }
      publish('settled');
      return true;
    },
  };
}

// Weak ownership follows the sync manager. Each map contains only live requests
// plus removed requests whose transport is still pending, never historical replies.
const repliesByManager = new WeakMap<ChildStoreManager, Map<string, ReturnType<typeof createPermissionReply>>>();

export function getPermissionReply(
  manager: ChildStoreManager,
  runtimeKey: string,
  sessionID: string,
  requestID: string,
  submit: (response: PermissionReply) => Promise<void>,
) {
  const key = JSON.stringify([runtimeKey, sessionID, requestID]);
  let replies = repliesByManager.get(manager);
  const existing = replies?.get(key);
  if (existing) return existing;

  const reply = createPermissionReply(submit);
  const isPresent = () => getRuntimeKey() === runtimeKey && [...manager.children.values()].some(
    (store) => store.getState().permission[sessionID]?.some((request) => request.id === requestID),
  );
  // A stale render must not recreate an actionable request after reconciliation.
  if (!isPresent()) {
    reply.retire();
    return reply;
  }
  if (!replies) {
    replies = new Map();
    repliesByManager.set(manager, replies);
  }
  const owner = replies;
  owner.set(key, reply);
  let removed = false;
  let disposed = false;
  const cleanup = () => {
    if (disposed || !removed || reply.getSnapshot() === 'pending') return;
    disposed = true;
    unsubscribePermissions();
    unsubscribeRuntime();
    unsubscribeReply();
    owner.delete(key);
    if (owner.size === 0) repliesByManager.delete(manager);
  };
  const retire = () => {
    if (removed) return;
    removed = true;
    reply.retire();
    cleanup();
  };
  const unsubscribePermissions = manager.subscribeAllSelected((state) => state.permission, () => {
    if (!isPresent()) retire();
  });
  const unsubscribeRuntime = subscribeRuntimeEndpointWillChange(retire);
  const unsubscribeReply = reply.subscribe(cleanup);
  return reply;
}

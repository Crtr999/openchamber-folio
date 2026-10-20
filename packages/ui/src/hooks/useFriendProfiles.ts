import React from 'react';

import { readFriendProfiles, type FriendProfiles } from '@/lib/friends';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

/**
 * The friends the user has named, shaped or coloured, for this runtime.
 *
 * The record lives in the window's own storage, so a second window and a
 * runtime switch are both events the reader has to hear about. A corrupt
 * record is read as no profiles rather than as a crash: the friends still
 * show, with their generated look.
 */
export const useFriendProfiles = (): FriendProfiles | null => {
  const [runtime, setRuntime] = React.useState(getRuntimeKey);
  const [profiles, setProfiles] = React.useState<FriendProfiles | null>(() => {
    try { return typeof localStorage !== 'undefined' ? readFriendProfiles(localStorage, getRuntimeKey()) : null; }
    catch { return null; }
  });

  React.useEffect(() => subscribeRuntimeEndpointChanged(() => setRuntime(getRuntimeKey())), []);

  React.useEffect(() => {
    const reload = () => {
      try { setProfiles(typeof localStorage !== 'undefined' ? readFriendProfiles(localStorage, runtime) : null); }
      catch { setProfiles(null); }
    };
    reload();
    if (typeof window === 'undefined') return;
    window.addEventListener('storage', reload);
    window.addEventListener('open-carter:friends-updated', reload);
    return () => {
      window.removeEventListener('storage', reload);
      window.removeEventListener('open-carter:friends-updated', reload);
    };
  }, [runtime]);

  return profiles;
};

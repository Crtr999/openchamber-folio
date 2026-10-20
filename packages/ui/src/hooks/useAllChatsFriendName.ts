import React from 'react';

import { folderFriendKey, readFriendProfiles, type FriendProfiles } from '@/lib/friends';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useChatsRoot } from '@/hooks/useChatsRoot';

/**
 * The name the user gave the All Chats friend, if they gave it one.
 *
 * All Chats is a structural area of the sidebar, but the friend that stands
 * for it is the user's to name like any other. When they rename it, the
 * sidebar says the new name; until then it keeps its own label.
 */
export const useAllChatsFriendName = (): string | null => {
    const chatsRoot = useChatsRoot();
    const [runtime, setRuntime] = React.useState(getRuntimeKey);
    const [profiles, setProfiles] = React.useState<FriendProfiles | null>(null);

    React.useEffect(() => subscribeRuntimeEndpointChanged(() => setRuntime(getRuntimeKey())), []);

    React.useEffect(() => {
        const reload = () => {
            try { setProfiles(readFriendProfiles(localStorage, runtime)); }
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

    if (!chatsRoot || !profiles) return null;
    return profiles.friends.find(item => item.agent === folderFriendKey(chatsRoot))?.name ?? null;
};

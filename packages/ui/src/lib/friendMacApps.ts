/** Which connected Mac apps this friend may use. The folder key is the friend. */

export const FRIEND_MAC_APPS = ['calendar', 'reminders'] as const;
export type FriendMacApp = (typeof FRIEND_MAC_APPS)[number];

const storageKey = (folderKey: string) => `open-carter:friend-mac-apps:v1:${folderKey}`;

export const readFriendMacApps = (folderKey: string): FriendMacApp[] => {
    try {
        const saved = JSON.parse(localStorage.getItem(storageKey(folderKey)) ?? 'null') as unknown;
        if (!Array.isArray(saved)) return [...FRIEND_MAC_APPS];
        return FRIEND_MAC_APPS.filter((app) => saved.includes(app));
    } catch {
        return [...FRIEND_MAC_APPS];
    }
};

export const writeFriendMacApps = (folderKey: string, apps: readonly FriendMacApp[]): FriendMacApp[] => {
    const next = FRIEND_MAC_APPS.filter((app) => apps.includes(app));
    localStorage.setItem(storageKey(folderKey), JSON.stringify(next));
    return next;
};

export const friendMayUseMacApp = (folderKey: string, app: FriendMacApp): boolean => readFriendMacApps(folderKey).includes(app);

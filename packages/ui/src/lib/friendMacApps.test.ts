import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { FRIEND_MAC_APPS, readFriendMacApps, writeFriendMacApps } from './friendMacApps';

const window = new Window();
Object.assign(globalThis, { window, localStorage: window.localStorage });

describe('friend Mac apps', () => {
    test('a friend may use both connected apps until that folder turns one off', () => {
        expect(readFriendMacApps('folder:/work')).toEqual([...FRIEND_MAC_APPS]);
        expect(writeFriendMacApps('folder:/work', ['reminders'])).toEqual(['reminders']);
        expect(readFriendMacApps('folder:/work')).toEqual(['reminders']);
        expect(readFriendMacApps('folder:/other')).toEqual([...FRIEND_MAC_APPS]);
    });
});

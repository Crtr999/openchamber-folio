import { beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { readChatDraft, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { useInputStore } from '@/sync/input-store';
import { shouldCarryNewSessionDraft, useComposerDraft } from '../useComposerDraft';

const home: ChatDraftIdentity = { runtimeKey: 'runtime-a', directory: '/home', sessionId: null };
const folder: ChatDraftIdentity = { runtimeKey: 'runtime-a', directory: '/repo', sessionId: null };

function renderNewSessionComposer() {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const result = { text: '', setMessage: (_text: string) => {} };

    function Probe({ identity }: { identity: ChatDraftIdentity }) {
        const [message, setMessage] = React.useState('');
        const messageRef = React.useRef(message);
        const confirmedMentionsRef = React.useRef(new Set<string>());
        React.useEffect(() => { messageRef.current = message; }, [message]);
        result.setMessage = setMessage;
        useComposerDraft({
            message,
            messageRef,
            setMessage,
            confirmedMentionsRef,
            identity,
            persistEnabled: true,
            initialDraft: { text: '', identity: home },
        });
        result.text = message;
        return null;
    }

    const render = (identity: ChatDraftIdentity) => {
        act(() => { root.render(React.createElement(Probe, { identity })); });
    };
    render(home);
    return {
        result,
        render,
        teardown: () => {
            act(() => { root.unmount(); });
            dom.restore();
        },
    };
}

beforeEach(() => {
    getDeferredSafeStorage().removeItem('openchamber.chatDrafts.v2');
    useInputStore.setState({ pendingComposerRestore: null, attachmentDraftKey: null, attachmentDrafts: new Map() });
    useInputStore.getState().clearAttachedFiles();
});

describe('new-session draft carry', () => {
    test('keeps typed text when the home composer moves to another folder', () => {
        const composer = renderNewSessionComposer();
        try {
            act(() => { composer.result.setMessage('hello folder'); });
            expect(composer.result.text).toBe('hello folder');

            composer.render(folder);

            expect(composer.result.text).toBe('hello folder');
            expect(readChatDraft(folder).text).toBe('hello folder');
            expect(readChatDraft(home).text).toBe('hello folder');
        } finally {
            composer.teardown();
        }
    });

    test('does not carry between open chats or over a saved draft', () => {
        const open = { ...home, sessionId: 'ses_open' };
        expect(shouldCarryNewSessionDraft(home, folder, '', 'typed', false)).toBe(true);
        expect(shouldCarryNewSessionDraft(open, folder, '', 'typed', false)).toBe(false);
        expect(shouldCarryNewSessionDraft(home, open, '', 'typed', false)).toBe(false);
        expect(shouldCarryNewSessionDraft(home, folder, 'saved', 'typed', false)).toBe(false);
        expect(shouldCarryNewSessionDraft(home, folder, '', '', false)).toBe(false);
        expect(shouldCarryNewSessionDraft(home, folder, '', 'typed', true)).toBe(false);
        expect(shouldCarryNewSessionDraft(null, folder, '', 'typed', false)).toBe(true);
    });
});

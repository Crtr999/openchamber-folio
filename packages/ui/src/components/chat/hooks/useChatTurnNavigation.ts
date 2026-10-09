import React from 'react';

type ChatHashTarget =
    | { kind: 'turn'; id: string }
    | { kind: 'message'; id: string };

const parseChatHashTarget = (hashValue: string): ChatHashTarget | null => {
    const value = hashValue.startsWith('#') ? hashValue.slice(1) : hashValue;
    if (!value) {
        return null;
    }

    const turnMatch = value.match(/^turn-(.+)$/);
    if (turnMatch?.[1]) {
        return { kind: 'turn', id: turnMatch[1] };
    }

    const messageMatch = value.match(/^(?:search-)?message-(.+)$/);
    if (messageMatch?.[1]) {
        return { kind: 'message', id: messageMatch[1] };
    }

    return null;
};

type TurnOffsetTarget =
    | { kind: 'noop' }
    | { kind: 'resume' }
    | { kind: 'turn'; turnId: string };

const resolveTurnOffsetTarget = (
    turnIds: string[],
    activeTurnId: string | null,
    offset: number,
): TurnOffsetTarget => {
    if (offset === 0) {
        return { kind: 'noop' };
    }

    if (turnIds.length === 0) {
        return { kind: 'noop' };
    }

    const baseIndex = activeTurnId ? turnIds.indexOf(activeTurnId) : turnIds.length - 1;
    const normalizedBase = baseIndex >= 0 ? baseIndex : turnIds.length - 1;
    const targetIndex = normalizedBase + offset;

    if (targetIndex >= turnIds.length) {
        return { kind: 'resume' };
    }

    const clampedTarget = Math.max(0, targetIndex);
    const targetTurnId = turnIds[clampedTarget];
    if (!targetTurnId) {
        return { kind: 'noop' };
    }

    return { kind: 'turn', turnId: targetTurnId };
};

const setHash = (hash: string | null): void => {
    if (typeof window === 'undefined') {
        return;
    }

    const nextHash = hash ? `#${hash}` : '';
    const nextUrl = `${window.location.pathname}${window.location.search}${nextHash}`;
    window.history.replaceState(window.history.state, '', nextUrl);
};

interface UseChatTurnNavigationOptions {
    sessionId: string | null;
    turnIds: string[];
    activeTurnId: string | null;
    scrollToTurn: (turnId: string, options?: { behavior?: ScrollBehavior }) => Promise<boolean>;
    scrollToMessage: (messageId: string, options?: { behavior?: ScrollBehavior }) => Promise<boolean>;
    resumeToBottom: () => void;
    loadMissingMessage?: (messageId: string) => Promise<boolean>;
}

export interface ChatTurnNavigation {
    scrollToTurnId: (turnId: string, options?: { behavior?: ScrollBehavior; updateHash?: boolean }) => Promise<boolean>;
    scrollToMessageId: (messageId: string, options?: { behavior?: ScrollBehavior; updateHash?: boolean }) => Promise<boolean>;
    scrollByTurnOffset: (offset: number, options?: { resumePastEnd?: boolean }) => Promise<boolean>;
    resumeToLatest: () => void;
}

export const useChatTurnNavigation = ({
    sessionId,
    turnIds,
    activeTurnId,
    scrollToTurn,
    scrollToMessage,
    resumeToBottom,
    loadMissingMessage,
}: UseChatTurnNavigationOptions): ChatTurnNavigation => {
    const turnIdsRef = React.useRef(turnIds);
    const activeTurnIdRef = React.useRef(activeTurnId);

    React.useEffect(() => {
        turnIdsRef.current = turnIds;
    }, [turnIds]);

    React.useEffect(() => {
        activeTurnIdRef.current = activeTurnId;
    }, [activeTurnId]);

    const scrollToTurnId = React.useCallback(async (
        turnId: string,
        options?: { behavior?: ScrollBehavior; updateHash?: boolean },
    ): Promise<boolean> => {
        if (!turnId) {
            return false;
        }

        if (options?.updateHash !== false) {
            setHash(`turn-${turnId}`);
        }

        return scrollToTurn(turnId, { behavior: options?.behavior });
    }, [scrollToTurn]);

    const scrollToMessageId = React.useCallback(async (
        messageId: string,
        options?: { behavior?: ScrollBehavior; updateHash?: boolean },
    ): Promise<boolean> => {
        if (!messageId) {
            return false;
        }

        if (options?.updateHash !== false) {
            setHash(`message-${messageId}`);
        }

        return scrollToMessage(messageId, { behavior: options?.behavior });
    }, [scrollToMessage]);

    const scrollByTurnOffset = React.useCallback(async (
        offset: number,
        options?: { resumePastEnd?: boolean },
    ): Promise<boolean> => {
        const turnIds = turnIdsRef.current;
        const target = resolveTurnOffsetTarget(turnIds, activeTurnIdRef.current, offset);

        if (target.kind === 'noop') {
            return offset === 0;
        }

        if (target.kind === 'resume') {
            if (options?.resumePastEnd === false) {
                const lastTurnId = turnIds[turnIds.length - 1];
                return lastTurnId ? scrollToTurnId(lastTurnId, { behavior: 'auto' }) : false;
            }

            setHash(null);
            resumeToBottom();
            return true;
        }

        return scrollToTurnId(target.turnId, { behavior: 'auto' });
    }, [resumeToBottom, scrollToTurnId]);

    const resumeToLatest = React.useCallback(() => {
        setHash(null);
        resumeToBottom();
    }, [resumeToBottom]);

    React.useEffect(() => {
        if (!sessionId || typeof window === 'undefined') {
            return;
        }

        let alive = true;
        const applyHash = async () => {
            const target = parseChatHashTarget(window.location.hash);
            if (!target) {
                return;
            }

            if (target.kind === 'turn') {
                void scrollToTurnId(target.id, { behavior: 'auto', updateHash: false });
                return;
            }

            const hash = window.location.hash;
            if (hash.startsWith('#search-message-') && loadMissingMessage && !await loadMissingMessage(target.id)) return;
            if (!alive || window.location.hash !== hash) return;
            const revealed = await scrollToMessageId(target.id, { behavior: 'auto', updateHash: false });
            if (alive && revealed && window.location.hash === hash && hash.startsWith('#search-message-')) setHash(null);
        };

        void applyHash();
        window.addEventListener('hashchange', applyHash);
        return () => {
            alive = false;
            window.removeEventListener('hashchange', applyHash);
        };
    }, [sessionId, scrollToMessageId, scrollToTurnId, turnIds.length, loadMissingMessage]);

    return {
        scrollToTurnId,
        scrollToMessageId,
        scrollByTurnOffset,
        resumeToLatest,
    };
};

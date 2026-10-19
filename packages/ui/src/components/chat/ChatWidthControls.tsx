import React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { CHAT_MIN_WIDTH, clampChatWidth } from '@/lib/chatWidth';
import { useUIStore } from '@/stores/useUIStore';

type ResizeGesture = {
    kind: 'pointer' | 'keyboard';
    original: number | null;
    width: number;
    startX: number;
    startWidth: number;
    direction: number;
    handle: HTMLDivElement;
    pointerId?: number;
};

/** Only this leaf observes width preferences. Drag previews never enter React or the store. */
export function ChatWidthControls({ enabled }: { enabled: boolean }) {
    const { t } = useI18n();
    const hintId = React.useId();
    const preferred = useUIStore(state => state.chatColumnWidth);
    const wide = useUIStore(state => state.wideChatLayoutEnabled);
    const overlay = React.useRef<HTMLDivElement>(null);
    const gesture = React.useRef<ResizeGesture | null>(null);
    const frame = React.useRef(0);
    const [available, setAvailable] = React.useState(0);
    const handles = React.useRef<Array<HTMLDivElement | null>>([]);
    const pointerPosition = React.useRef<{ x: number; y: number; type: string } | null>(null);

    const paintHover = React.useCallback((handle: HTMLDivElement) => {
        const pointer = pointerPosition.current;
        const bounds = handle.getBoundingClientRect();
        handle.toggleAttribute('data-edge-hover', pointer !== null && pointer.type !== 'touch'
            && pointer.x >= bounds.left && pointer.x <= bounds.right
            && pointer.y >= bounds.top && pointer.y <= bounds.bottom);
    }, []);

    const column = React.useCallback(() => overlay.current?.parentElement, []);
    const defaultWidth = React.useCallback(() => (wide ? 64 : 48) * parseFloat(getComputedStyle(document.documentElement).fontSize), [wide]);
    const width = () => clampChatWidth(gesture.current?.width ?? preferred ?? defaultWidth(), column()?.clientWidth ?? available);
    const paint = React.useCallback((value: number | null) => {
        const owner = column();
        if (!owner) return;
        if (value === null) owner.style.removeProperty('--oc-chat-width');
        else owner.style.setProperty('--oc-chat-width', `${value}px`);
        const visibleWidth = clampChatWidth(value ?? defaultWidth(), owner.clientWidth);
        for (const handle of handles.current) handle?.setAttribute('aria-valuenow', String(visibleWidth));
    }, [column, defaultWidth]);
    const cancelFrame = React.useCallback(() => {
        if (frame.current) cancelAnimationFrame(frame.current);
        frame.current = 0;
    }, []);
    const finish = React.useCallback((commit: boolean) => {
        const current = gesture.current;
        if (!current) return;
        gesture.current = null;
        cancelFrame();
        overlay.current?.removeAttribute('data-resizing');
        current.handle.removeAttribute('data-resizing');
        column()?.removeAttribute('data-chat-resizing');
        if (current.pointerId !== undefined && current.handle.hasPointerCapture?.(current.pointerId)) {
            current.handle.releasePointerCapture(current.pointerId);
        }
        if (commit && current.width !== current.startWidth) {
            const next = Math.max(CHAT_MIN_WIDTH, current.width);
            paint(next);
            useUIStore.getState().setChatColumnWidth(next);
        } else paint(current.original);
        // Capture can leave CSS :hover stuck until another mouse move. Recheck the
        // final geometry explicitly, including a grip that moved during resizing.
        if (commit) paintHover(current.handle);
        else current.handle.removeAttribute('data-edge-hover');
    }, [cancelFrame, column, paint, paintHover]);
    const preview = (value: number) => {
        const current = gesture.current;
        if (!current) return;
        current.width = clampChatWidth(value, column()?.clientWidth ?? available);
        if (!frame.current) frame.current = requestAnimationFrame(() => {
            frame.current = 0;
            if (gesture.current) paint(gesture.current.width);
        });
    };

    React.useLayoutEffect(() => {
        if (!enabled) return;
        const owner = column();
        if (!owner) return;
        const measure = () => setAvailable(owner.clientWidth);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(owner);
        const cancel = () => finish(false);
        const onVisibility = () => { if (document.visibilityState === 'hidden') cancel(); };
        window.addEventListener('blur', cancel);
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            observer.disconnect();
            window.removeEventListener('blur', cancel);
            document.removeEventListener('visibilitychange', onVisibility);
            // Removing a chat or switching into Home must release capture and the preview.
            finish(false);
            owner.style.removeProperty('--oc-chat-width');
            owner.removeAttribute('data-chat-resizing');
        };
    }, [enabled, column, finish]);

    React.useLayoutEffect(() => {
        if (!enabled) return;
        // An authoritative settings update cancels an in-progress local preview.
        finish(false);
        paint(preferred);
    }, [enabled, preferred, finish, paint]);

    if (!enabled) return null;
    const currentWidth = width();
    const begin = (handle: HTMLDivElement, direction: number, kind: ResizeGesture['kind'], startX = 0, pointerId?: number) => {
        finish(false);
        const startWidth = width();
        gesture.current = { kind, original: preferred, width: startWidth, startX, startWidth, direction, handle, pointerId };
        handle.setAttribute('data-resizing', 'true');
        handle.removeAttribute('data-edge-hover');
        overlay.current?.setAttribute('data-resizing', 'true');
        column()?.setAttribute('data-chat-resizing', 'true');
    };
    const reset = () => {
        finish(false);
        paint(null);
        useUIStore.getState().setChatColumnWidth(null);
    };

    return <div ref={overlay} className="oc-chat-width-controls" data-chat-width-controls data-can-resize={available > CHAT_MIN_WIDTH}>
        <span id={hintId} className="sr-only">{t('chat.width.hint')}</span>
        {(['start', 'end'] as const).map((edge, index) => <div
            key={edge}
            ref={node => { handles.current[index] = node; }}
            className="oc-chat-width-edge"
            data-edge={edge}
            role="separator"
            tabIndex={available > CHAT_MIN_WIDTH ? 0 : -1}
            aria-orientation="vertical"
            aria-label={t('chat.width.resize')}
            aria-describedby={hintId}
            aria-valuemin={Math.min(CHAT_MIN_WIDTH, available)}
            aria-valuemax={available}
            aria-valuenow={currentWidth}
            title={t('chat.width.hint')}
            onDoubleClick={reset}
            onPointerEnter={event => {
                pointerPosition.current = { x: event.clientX, y: event.clientY, type: event.pointerType };
                paintHover(event.currentTarget);
            }}
            onPointerLeave={event => event.currentTarget.removeAttribute('data-edge-hover')}
            onPointerDown={event => {
                if (event.button !== 0 || !event.isPrimary || available <= CHAT_MIN_WIDTH) return;
                event.preventDefault();
                event.currentTarget.setAttribute('data-pointer-focus', 'true');
                const direction = (edge === 'start' ? -1 : 1) * (getComputedStyle(event.currentTarget).direction === 'rtl' ? -1 : 1);
                event.currentTarget.focus();
                begin(event.currentTarget, direction, 'pointer', event.clientX, event.pointerId);
                event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={event => {
                pointerPosition.current = { x: event.clientX, y: event.clientY, type: event.pointerType };
                const current = gesture.current;
                if (!current) paintHover(event.currentTarget);
                if (current?.kind !== 'pointer' || current.pointerId !== event.pointerId) return;
                preview(current.startWidth + 2 * current.direction * (event.clientX - current.startX));
            }}
            onPointerUp={event => {
                pointerPosition.current = { x: event.clientX, y: event.clientY, type: event.pointerType };
                const current = gesture.current;
                if (current?.kind !== 'pointer' || current.pointerId !== event.pointerId) return;
                preview(current.startWidth + 2 * current.direction * (event.clientX - current.startX));
                finish(true);
            }}
            onPointerCancel={() => finish(false)}
            onLostPointerCapture={() => finish(false)}
            onBlur={event => {
                event.currentTarget.removeAttribute('data-pointer-focus');
                finish(gesture.current?.kind === 'keyboard');
            }}
            onKeyDown={event => {
                event.currentTarget.removeAttribute('data-pointer-focus');
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); return; }
                if (event.key === 'Enter') { event.preventDefault(); finish(true); return; }
                if (event.altKey || event.ctrlKey || event.metaKey) return;
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                event.stopPropagation();
                if (gesture.current?.kind !== 'keyboard') {
                    const direction = (edge === 'start' ? -1 : 1) * (getComputedStyle(event.currentTarget).direction === 'rtl' ? -1 : 1);
                    begin(event.currentTarget, direction, 'keyboard');
                }
                const current = gesture.current;
                if (!current) return;
                const step = event.shiftKey ? 80 : 16;
                preview(event.key === 'Home' ? CHAT_MIN_WIDTH : event.key === 'End' ? available
                    : current.width + (event.key === 'ArrowRight' ? 1 : -1) * current.direction * step);
            }}
            onKeyUp={event => {
                if (gesture.current?.kind === 'keyboard' && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) finish(true);
            }}
        ><span aria-hidden="true" /></div>)}
        {preferred !== null && <Button variant="ghost" size="xs" type="button" className="oc-chat-width-reset" onClick={reset}>
            {t('chat.width.reset')}
        </Button>}
    </div>;
}

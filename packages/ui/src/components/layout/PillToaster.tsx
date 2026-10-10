import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { PILL_EVENT, type PillTone } from '@/lib/pill';

type Pill = { id: number; text: string; tone: PillTone; leaving: boolean };

/** "Done. It disappears." One pill at a time: pops in, holds, collapses away. */
export function PillToaster() {
    const [pill, setPill] = React.useState<Pill | null>(null);
    const counter = React.useRef(0);
    React.useEffect(() => {
        const timers: number[] = [];
        const onPill = (event: Event) => {
            if (!(event instanceof CustomEvent)) return;
            const detail = event.detail as { text?: unknown; tone?: unknown };
            if (typeof detail?.text !== 'string' || !detail.text.trim()) return;
            const id = ++counter.current;
            const tone: PillTone = detail.tone === 'error' || detail.tone === 'info' ? detail.tone : 'success';
            setPill({ id, text: detail.text.slice(0, 140), tone, leaving: false });
            timers.push(window.setTimeout(() => setPill((current) => current?.id === id ? { ...current, leaving: true } : current), tone === 'error' ? 4200 : 2400));
            timers.push(window.setTimeout(() => setPill((current) => current?.id === id ? null : current), tone === 'error' ? 4600 : 2800));
        };
        window.addEventListener(PILL_EVENT, onPill);
        return () => { window.removeEventListener(PILL_EVENT, onPill); timers.forEach((timer) => window.clearTimeout(timer)); };
    }, []);
    if (!pill) return null;
    return <div role="status" aria-live="polite" key={pill.id}
        className={cn('oc-pill-toast app-region-no-drag pointer-events-none fixed bottom-5 left-1/2 z-[57] flex max-w-[min(520px,90vw)] items-center gap-2 rounded-full border bg-[var(--surface-elevated,var(--background))] py-1.5 pl-2 pr-3.5 shadow-[0_12px_40px_-8px_rgba(0,0,0,0.55)]',
            pill.tone === 'error' ? 'border-red-500/40' : pill.tone === 'info' ? 'border-border/80' : 'border-emerald-500/30',
            pill.leaving && 'oc-pill-toast-out')}>
        <span className={cn('oc-saved-tick flex size-5 shrink-0 items-center justify-center rounded-full',
            pill.tone === 'error' ? 'bg-red-500/20 text-red-400' : pill.tone === 'info' ? 'bg-muted text-foreground' : 'bg-emerald-500/20 text-emerald-400')}>
            <Icon name={pill.tone === 'error' ? 'close' : pill.tone === 'info' ? 'information' : 'check'} className="size-3.5" />
        </span>
        <span className="truncate text-[12.5px] text-foreground">{pill.text}</span>
    </div>;
}

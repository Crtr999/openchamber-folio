import React from 'react';
import type { Meeting } from '@/lib/meetings/contract';

type Segment = Meeting['segments'][number];

const timestamp = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const FRESH_MS = 8000;
const STEP_MS = 25;

/** Reveals new text a few characters at a time so a phrase is seen arriving. */
export function TypedText({ text, animate }: { text: string; animate: boolean }) {
    const [shown, setShown] = React.useState(animate ? 0 : text.length);
    React.useEffect(() => {
        if (shown >= text.length) return;
        const timer = setTimeout(() => setShown((count) => Math.min(text.length, count + Math.max(2, Math.ceil(text.length / 40)))), STEP_MS);
        return () => clearTimeout(timer);
    }, [shown, text]);
    return <>{text.slice(0, shown)}</>;
}

type Labels = { microphone: string; system: string; listening: string };

/**
 * The transcript as it grows. While capture is live, segments that just arrived
 * type in and the view follows the newest line; a finished transcript is static.
 */
export function MeetingTranscript({ segments, live, labels }: { segments: readonly Segment[]; live: boolean; labels: Labels }) {
    const ordered = React.useMemo(() => [...segments].sort((a, b) => a.startMs - b.startMs || a.source.localeCompare(b.source)), [segments]);
    const end = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => { if (live) end.current?.scrollIntoView?.({ block: 'nearest' }); }, [live, ordered.length]);
    return <div role="log" aria-live="polite" className="space-y-2">
        {ordered.map((segment) => <p key={`${segment.source}:${segment.startMs}`} className="whitespace-pre-wrap text-sm">
            <span className="mr-2 text-xs text-muted-foreground">{timestamp(segment.startMs)} · {segment.source === 'microphone' ? labels.microphone : labels.system}</span>
            <TypedText text={segment.text} animate={live && Date.now() - Date.parse(segment.createdAt) < FRESH_MS} />
        </p>)}
        {live && <p className="text-xs text-muted-foreground">{labels.listening}…</p>}
        <div ref={end} />
    </div>;
}

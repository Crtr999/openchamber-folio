import './HomeFriendAvatar.css';
import React from 'react';
import { friendColorVariable, type FriendColor, type FriendBody } from '@/lib/friends';
import { cn } from '@/lib/utils';

// Soft round bodies on a 64-unit grid. Polygons are rounded by a matching
// stroke with round joins; eyes sit where each body has the most room.
const rounded = { strokeWidth: 9, strokeLinejoin: 'round' } as const;
const figures = {
    blob: { outline: <path d="M34 5C48 6 59 16 58 31C57 46 47 58 31 58C15 58 5 47 6 32C7 20 14 13 21 9C25 6 29 5 34 5Z" />, eyes: [25, 39, 30] },
    pebble: { outline: <ellipse cx="32" cy="33" rx="27" ry="21" transform="rotate(-10 32 33)" />, eyes: [25, 39, 32] },
    cloud: { outline: <><circle cx="20" cy="36" r="13" /><circle cx="33" cy="26" r="16" /><circle cx="45" cy="36" r="13" /><rect x="8" y="34" width="49" height="20" rx="10" /></>, eyes: [26, 39, 35] },
    drop: { outline: <path d="M32 5C36 11 54 27 54 40A22 22 0 0 1 10 40C10 27 28 11 32 5Z" />, eyes: [26, 38, 40] },
    squircle: { outline: <rect x="7" y="7" width="50" height="50" rx="19" />, eyes: [25, 39, 31] },
    hex: { outline: <polygon points="32,10 51,21 51,43 32,54 13,43 13,21" {...rounded} stroke="currentColor" />, eyes: [25, 39, 31] },
    star: { outline: <polygon points="32,12 39,24.5 53,27.5 43.5,38 45,52 32,46 19,52 20.5,38 11,27.5 25,24.5" {...rounded} stroke="currentColor" />, eyes: [27.5, 36.5, 34] },
    flower: { outline: <><circle cx="32" cy="32" r="18" /><circle cx="47.7" cy="38.5" r="9.5" /><circle cx="38.5" cy="47.7" r="9.5" /><circle cx="25.5" cy="47.7" r="9.5" /><circle cx="16.3" cy="38.5" r="9.5" /><circle cx="16.3" cy="25.5" r="9.5" /><circle cx="25.5" cy="16.3" r="9.5" /><circle cx="38.5" cy="16.3" r="9.5" /><circle cx="47.7" cy="25.5" r="9.5" /></>, eyes: [26, 38, 32] },
    ghost: { outline: <path d="M10 31A22 22 0 0 1 54 31V53C54 56 51 57.5 49 55.5L45 51.5L39 56.5L32 51.5L25 56.5L19 51.5L15 55.5C13 57.5 10 56 10 53Z" strokeWidth="2" strokeLinejoin="round" stroke="currentColor" />, eyes: [25, 39, 29] },
    peak: { outline: <polygon points="32,13 54,51 10,51" {...rounded} stroke="currentColor" />, eyes: [27, 37, 39] },
    capsule: { outline: <rect x="5" y="15" width="54" height="35" rx="17.5" />, eyes: [25, 39, 32] },
    bean: { outline: <path d="M19 10C29 5 35 15 44 13C54 11 60 22 58 35C56 49 44 58 30 57C15 56 6 45 7 31C8 21 12 13 19 10Z" />, eyes: [26, 40, 33] },
    crystal: { outline: <polygon points="32,4 54,24 45,54 19,54 10,24" {...rounded} stroke="currentColor" />, eyes: [27, 37, 34] },
    crown: { outline: <path d="M8 49L12 15L25 31L32 9L39 31L52 15L56 49Z" {...rounded} stroke="currentColor" />, eyes: [26, 38, 36] },
    crescent: { outline: <path d="M41 6A26 26 0 1 0 41 58A21 21 0 1 1 41 6Z" />, eyes: [21, 30, 32] },
    bolt: { outline: <path d="M38 3L12 37H27L23 61L52 25H35L38 3Z" {...rounded} stroke="currentColor" />, eyes: [27, 37, 27] },
    shield: { outline: <path d="M32 4L55 12V31C55 44 45 55 32 60C19 55 9 44 9 31V12Z" />, eyes: [26, 38, 29] },
    heart: { outline: <path d="M32 58C8 40 4 24 14 14C22 5 32 13 32 23C32 13 42 5 50 14C60 24 56 40 32 58Z" />, eyes: [26, 38, 27] },
} satisfies Record<FriendBody, { outline: React.ReactNode; eyes: readonly [number, number, number] }>;

/** Decorative friend face: a soft body in a theme color with two small eyes. */
export function HomeFriendAvatar({ body, color, className, label }: { body: FriendBody; color: FriendColor; className?: string; label?: string }) {
    const { outline, eyes: [left, right, y] } = figures[body];
    return <svg viewBox="0 0 64 64" className={cn('oc-friend-avatar', className)} style={{ color: friendColorVariable(color) }}
        role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} data-body={body} data-color={color}>
        <g fill="currentColor">{outline}</g>
        <g className="oc-friend-avatar-eyes"><rect x={left - 2.5} y={y - 4.5} width="5" height="9" rx="2.5" /><rect x={right - 2.5} y={y - 4.5} width="5" height="9" rx="2.5" /></g>
    </svg>;
}

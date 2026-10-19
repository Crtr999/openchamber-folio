import { z } from 'zod';

export const CHAT_MIN_WIDTH = 480;
export const chatWidthSchema = z.number().finite().int().min(CHAT_MIN_WIDTH).nullable();

/** A saved preference is not reduced when a sidebar or a panel takes space. */
export const clampChatWidth = (width: number, available: number): number =>
    Math.round(Math.min(Math.max(0, available), Math.max(CHAT_MIN_WIDTH, width)));

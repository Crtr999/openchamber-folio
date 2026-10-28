import { z } from 'zod';
import { websiteChatSnapshotSchema } from './websiteChat';

export const websiteModelContinuationSchema = z.object({
  url: z.string().regex(/^https:\/\/gemini\.google\.com\/app\/[^/?#]+$/),
  userCount: z.number().int().positive(),
  answerHash: z.string().regex(/^[a-f0-9]{64}$/),
});
type Snapshot = Extract<z.infer<typeof websiteChatSnapshotSchema>, { kind: 'ready' }>;

/** An observed page is reusable only while its last completed turn is unchanged. */
export async function validateWebsiteModelStart(start: Snapshot, continuation?: z.infer<typeof websiteModelContinuationSchema>) {
  if (start.busy || start.draft.trim()) throw new Error('The website chat is busy or has a draft. Nothing was sent.');
  if (!continuation) {
    if (start.messages.length || start.userCount) throw new Error('The website did not open a fresh chat. Nothing was sent; check its account connection.');
    return;
  }
  const answer = start.messages.at(-1);
  if (start.url !== continuation.url || start.partial || start.userCount !== continuation.userCount || answer?.role !== 'assistant') throw new Error('The Gemini conversation changed. Nothing was sent; send a new native message to continue.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(answer.text));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== continuation.answerHash) throw new Error('The Gemini answer changed. Nothing was sent; send a new native message to continue.');
}

/** Old user messages and answers cannot acknowledge a newly submitted turn. */
export function websiteModelTurn(snapshot: Snapshot, start: Snapshot) {
  const lastUser = snapshot.messages.map(row => row.role).lastIndexOf('user');
  const acknowledged = !snapshot.partial && snapshot.userCount > start.userCount && lastUser >= start.messages.length;
  const last = snapshot.messages.at(-1);
  const answer = acknowledged && lastUser >= 0 && lastUser < snapshot.messages.length - 1 && last?.role === 'assistant' ? last : null;
  return { acknowledged, answer };
}

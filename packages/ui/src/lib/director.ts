import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

const improvedSchema = z.object({
  text: z.string().min(1),
  used: z.object({ rules: z.boolean(), memoryFile: z.boolean(), entries: z.number().int().nonnegative() }),
  model: z.string().nullable(),
});
export type DirectorResult = z.infer<typeof improvedSchema>;

/** `zdr` means the folder keeps its content on one provider, so the Director stays out of it. */
export class DirectorError extends Error {
  constructor(message: string, readonly reason: 'zdr' | 'unavailable' | 'cancelled') {
    super(message);
  }
}

/** Asks the folder's friend to rewrite a draft using that folder's rules and memory. */
export async function improveWithDirector({ directory, folderName, prompt, signal }: {
  directory: string;
  folderName: string;
  prompt: string;
  signal?: AbortSignal;
}): Promise<DirectorResult> {
  let response: Response;
  try {
    response = await runtimeFetch('/api/openchamber/director/improve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory, folderName, prompt }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new DirectorError('Cancelled', 'cancelled');
    throw new DirectorError(error instanceof Error ? error.message : 'The Director could not be reached.', 'unavailable');
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const body = z.object({ error: z.string().optional(), reason: z.string().optional() }).safeParse(payload);
    throw new DirectorError(body.success && body.data.error ? body.data.error : 'The Director is unavailable.', body.success && body.data.reason === 'zdr' ? 'zdr' : 'unavailable');
  }
  const parsed = improvedSchema.safeParse(payload);
  if (!parsed.success) throw new DirectorError('The Director returned something unreadable.', 'unavailable');
  return parsed.data;
}

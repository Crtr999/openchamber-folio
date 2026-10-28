import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

const entrySchema = z.object({
  id: z.string().min(1), title: z.string().max(160), excerpt: z.string().max(1000),
  createdAt: z.number().finite().nonnegative().max(8_640_000_000_000_000), seen: z.boolean(), dismissed: z.boolean(),
});
const inboxSchema = z.object({ inbox: z.array(entrySchema) });
export type HomeSuggestion = z.infer<typeof entrySchema> & { projectId: string; directory: string; friend: string };
export type HomeSuggestionFolder = { id: string; path: string; label?: string };

const inboxPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/companion/inbox`;

/** Only existing, server-authorized companion results. No source or chat-body reads. */
export async function readHomeSuggestions(
  folders: readonly HomeSuggestionFolder[], signal: AbortSignal, request = runtimeFetch,
): Promise<{ items: HomeSuggestion[]; failedProjectIds: string[] }> {
  const results = await Promise.all(folders.map(async folder => {
    try {
      const response = await request(inboxPath(folder.id), { signal });
      // The server excludes confidential folders before reading their inbox.
      if (response.status === 403 || response.status === 423) return { items: [], failedProjectIds: [] };
      if (!response.ok) throw new Error('Companion inbox unavailable');
      const parsed = inboxSchema.parse(await response.json());
      return { items: parsed.inbox.filter(item => !item.dismissed && !item.seen && item.excerpt.trim()).map(item => ({
        ...item, projectId: folder.id, directory: folder.path,
        friend: folder.label || folder.path.split('/').filter(Boolean).pop() || folder.path,
      })), failedProjectIds: [] };
    } catch (error) {
      if (signal.aborted) throw error;
      return { items: [], failedProjectIds: [folder.id] };
    }
  }));
  return {
    items: results.flatMap(result => result.items).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)),
    failedProjectIds: results.flatMap(result => result.failedProjectIds),
  };
}

/** The existing project file owns dismissal, including across clients and reloads. */
export async function dismissHomeSuggestion(item: HomeSuggestion, signal: AbortSignal, request = runtimeFetch): Promise<void> {
  const response = await request(`${inboxPath(item.projectId)}/${encodeURIComponent(item.id)}`, {
    method: 'PATCH', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dismissed: true }),
  });
  if (!response.ok) throw new Error('Companion dismissal was not saved');
  inboxSchema.parse(await response.json());
}

/** Keep the source wording, removing only the leading Markdown list/heading marker. */
export const homeSuggestionHeadline = (item: Pick<HomeSuggestion, 'excerpt' | 'title'>): string =>
  item.excerpt.split('\n').map(line => line.trim().replace(/^(?:#{1,6}\s+|[-*]\s+|\d+[.)]\s+)/, '')).find(Boolean) || item.title;

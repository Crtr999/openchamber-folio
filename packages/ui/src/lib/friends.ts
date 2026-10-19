import { z } from 'zod';
import type { Agent } from '@/lib/opencode/model';

const profileSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), aliases: z.array(z.object({ agent: z.string().min(1), name: z.string().trim().min(1).max(32) }).strict()).max(128) }).strict();
const linkSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('creating') }).strict(),
  z.object({ state: z.literal('ready'), sessionId: z.string().min(1) }).strict(),
]);
export type FriendProfiles = z.infer<typeof profileSchema>;
export type FriendLink = z.infer<typeof linkSchema>;
type StorageAccess = Pick<Storage, 'getItem' | 'setItem'>;
const profileKey = (runtime: string) => `open-carter:friends:v1:${JSON.stringify(runtime)}`;
const linkKey = (runtime: string, directory: string, agent: string) => `open-carter:friend-chat:v1:${JSON.stringify([runtime, directory, agent])}`;

export function readFriendProfiles(storage: StorageAccess, runtime: string): FriendProfiles {
  const raw = storage.getItem(profileKey(runtime));
  return raw === null ? { version: 1, revision: 0, aliases: [] } : profileSchema.parse(JSON.parse(raw));
}
export function saveFriendName(storage: StorageAccess, runtime: string, agent: string, name: string, revision: number): FriendProfiles {
  const current = readFriendProfiles(storage, runtime);
  if (current.revision !== revision) throw new Error('Friend names changed in another window. Refresh before saving.');
  const next = profileSchema.parse({ ...current, revision: current.revision + 1, aliases: [...current.aliases.filter(item => item.agent !== agent), { agent, name }] });
  storage.setItem(profileKey(runtime), JSON.stringify(next));
  return next;
}
const familiarNames = new Map([['manager', 'Milo'], ['explore', 'Sage'], ['build', 'Pip']]);
export function friendName(profiles: FriendProfiles | null, agent: Pick<Agent, 'name' | 'displayName'>): string {
  return profiles?.aliases.find(item => item.agent === agent.name)?.name ?? familiarNames.get(agent.name) ?? agent.displayName;
}
export function readFriendLink(storage: StorageAccess, runtime: string, directory: string, agent: string): FriendLink | null {
  const raw = storage.getItem(linkKey(runtime, directory, agent));
  return raw === null ? null : linkSchema.parse(JSON.parse(raw));
}
export function writeFriendLink(storage: StorageAccess, runtime: string, directory: string, agent: string, link: FriendLink): void {
  storage.setItem(linkKey(runtime, directory, agent), JSON.stringify(linkSchema.parse(link)));
}

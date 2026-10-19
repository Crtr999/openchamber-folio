import { z } from 'zod';
import type { Agent } from '@/lib/opencode/model';

/** Avatar shapes drawn by `HomeFriendAvatar`; ids are persisted, so only append. */
export const FRIEND_BODIES = ['blob', 'pebble', 'cloud', 'drop', 'squircle', 'hex', 'star', 'flower', 'ghost', 'peak', 'capsule', 'bean'] as const;
/** Theme color roles an avatar may use; ids are persisted, so only append. */
export const FRIEND_COLORS = ['primary', 'keyword', 'type', 'function', 'number', 'string', 'operator', 'variable', 'success', 'comment'] as const;
export type FriendBody = (typeof FRIEND_BODIES)[number];
export type FriendColor = (typeof FRIEND_COLORS)[number];
export type FriendAppearance = { body: FriendBody; color: FriendColor };

// Theme roles only: avatars follow every theme and never carry status meaning.
const colorVariables = {
  primary: 'var(--primary-base)', keyword: 'var(--syntax-keyword)', type: 'var(--syntax-type)', function: 'var(--syntax-function)',
  number: 'var(--syntax-number)', string: 'var(--syntax-string)', operator: 'var(--syntax-operator)', variable: 'var(--syntax-variable)',
  success: 'var(--status-success)', comment: 'var(--syntax-comment)',
} satisfies Record<FriendColor, string>;
/** CSS value for an avatar color role. */
export const friendColorVariable = (color: FriendColor): string => colorVariables[color];

const revisionSchema = z.number().int().nonnegative();
const nameSchema = z.string().trim().min(1).max(32);
const v1Schema = z.object({ version: z.literal(1), revision: revisionSchema, aliases: z.array(z.object({ agent: z.string().min(1), name: nameSchema }).strict()).max(128) }).strict();
const friendSchema = z.object({ agent: z.string().min(1), name: nameSchema.optional(), body: z.enum(FRIEND_BODIES).optional(), color: z.enum(FRIEND_COLORS).optional() }).strict();
const profileSchema = z.object({ version: z.literal(2), revision: revisionSchema, friends: z.array(friendSchema).max(128) }).strict()
  .refine(value => new Set(value.friends.map(item => item.agent)).size === value.friends.length, { message: 'Duplicate friend entry' });
const linkSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('creating') }).strict(),
  z.object({ state: z.literal('ready'), sessionId: z.string().min(1) }).strict(),
]);
export type FriendProfiles = z.infer<typeof profileSchema>;
export type FriendLink = z.infer<typeof linkSchema>;
type StorageAccess = Pick<Storage, 'getItem' | 'setItem'>;
// The key keeps its original name; the record inside carries its own version.
const profileKey = (runtime: string) => `open-carter:friends:v1:${JSON.stringify(runtime)}`;
const linkKey = (runtime: string, directory: string, agent: string) => `open-carter:friend-chat:v1:${JSON.stringify([runtime, directory, agent])}`;

/** Thrown when another window saved first; the caller must re-read before saving again. */
export class FriendRevisionConflict extends Error {
  constructor() { super('Friend names changed in another window. Refresh before saving.'); this.name = 'FriendRevisionConflict'; }
}

// Version 1 held names only. The first matching alias was the displayed one, so
// it wins; the revision carries over so pending revision checks stay valid.
function migrate(value: z.infer<typeof v1Schema>): FriendProfiles {
  const friends = value.aliases.filter((item, index) => value.aliases.findIndex(other => other.agent === item.agent) === index);
  return profileSchema.parse({ version: 2, revision: value.revision, friends });
}
const storedSchema = z.union([v1Schema.transform(migrate), profileSchema]);

/** Reads and validates saved friend presentation. Corrupt data throws; it is never treated as empty. */
export function readFriendProfiles(storage: StorageAccess, runtime: string): FriendProfiles {
  const raw = storage.getItem(profileKey(runtime));
  if (raw === null) return { version: 2, revision: 0, friends: [] };
  return storedSchema.parse(JSON.parse(raw));
}

export function saveFriendProfile(storage: StorageAccess, runtime: string, agent: string, input: { name: string } & FriendAppearance, revision: number): FriendProfiles {
  const current = readFriendProfiles(storage, runtime);
  if (current.revision !== revision) throw new FriendRevisionConflict();
  const entry = { agent, name: input.name, body: input.body, color: input.color };
  const next = profileSchema.parse({ ...current, revision: current.revision + 1, friends: [...current.friends.filter(item => item.agent !== agent), entry] });
  storage.setItem(profileKey(runtime), JSON.stringify(next));
  return next;
}

const familiarNames = new Map([['manager', 'Milo'], ['explore', 'Sage'], ['build', 'Pip']]);
export function friendName(profiles: FriendProfiles | null, agent: Pick<Agent, 'name' | 'displayName'>): string {
  return profiles?.friends.find(item => item.agent === agent.name)?.name ?? familiarNames.get(agent.name) ?? agent.displayName;
}

function hash(value: string, seed: number): number {
  let result = seed;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  // Final avalanche so short, similar ids still spread across the palette.
  result = Math.imul(result ^ (result >>> 16), 0x85ebca6b);
  result = Math.imul(result ^ (result >>> 13), 0xc2b2ae35);
  return (result ^ (result >>> 16)) >>> 0;
}
// Build owns the success identity color everywhere agents are marked, so other defaults avoid it.
const defaultColors = FRIEND_COLORS.filter(color => color !== 'success');
/** Stable look for an agent nobody customized. */
export function defaultFriendAppearance(agent: string): FriendAppearance {
  return {
    body: FRIEND_BODIES[hash(agent, 374761393) % FRIEND_BODIES.length],
    color: agent === 'build' ? 'success' : defaultColors[hash(agent, 2166136261) % defaultColors.length],
  };
}
export function friendAppearance(profiles: FriendProfiles | null, agent: string): FriendAppearance {
  const saved = profiles?.friends.find(item => item.agent === agent);
  const fallback = defaultFriendAppearance(agent);
  return { body: saved?.body ?? fallback.body, color: saved?.color ?? fallback.color };
}

export function readFriendLink(storage: StorageAccess, runtime: string, directory: string, agent: string): FriendLink | null {
  const raw = storage.getItem(linkKey(runtime, directory, agent));
  return raw === null ? null : linkSchema.parse(JSON.parse(raw));
}
export function writeFriendLink(storage: StorageAccess, runtime: string, directory: string, agent: string, link: FriendLink): void {
  storage.setItem(linkKey(runtime, directory, agent), JSON.stringify(linkSchema.parse(link)));
}

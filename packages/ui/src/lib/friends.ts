import { z } from 'zod';
import type { Agent } from '@/lib/opencode/model';
import { providerBindingFromFolderName } from './projectProviderBinding';

/** Avatar shapes drawn by `HomeFriendAvatar`; ids are persisted, so only append. */
export const FRIEND_BODIES = ['blob', 'pebble', 'cloud', 'drop', 'squircle', 'hex', 'star', 'flower', 'ghost', 'peak', 'capsule', 'bean', 'crystal', 'crown', 'crescent', 'bolt', 'shield', 'heart'] as const;
/** Theme color roles an avatar may use; ids are persisted, so only append. */
/**
 * Theme colour roles a friend may wear.
 *
 * The first ten are the app's own syntax palette: quiet, and they follow the
 * theme. The last five are the loud ones — the colours a person actually
 * picks for a character, and the ones a sketch in a notebook is drawn with.
 */
export const FRIEND_COLORS = [
  'primary', 'keyword', 'type', 'function', 'number', 'string', 'operator', 'variable', 'success', 'comment',
  'crimson', 'amber', 'azure', 'violet',
] as const;

/** The loud end of the palette, drawn after the quiet ones. */
export const BOLD_FRIEND_COLORS = ['crimson', 'amber', 'success', 'azure', 'violet'] as const;
export type FriendBody = (typeof FRIEND_BODIES)[number];
export type FriendColor = (typeof FRIEND_COLORS)[number];
export type FriendAppearance = { body: FriendBody; color: FriendColor };
export type FolderGuardrailEffect = 'allow' | 'ask' | 'deny';

export type FolderGuardrailState = {
  zdrLocked: boolean;
  allowedProviders: string[];
  computerUse: FolderGuardrailEffect;
  macControl: FolderGuardrailEffect;
  browserControl: FolderGuardrailEffect;
  webAccess: FolderGuardrailEffect;
  fileAndShell: FolderGuardrailEffect;
  externalDirectory: FolderGuardrailEffect;
  subagents: FolderGuardrailEffect;
};

export type FolderGuardrailsSummary = FolderGuardrailState & {
  badges: string[];
};

// Theme roles only: avatars follow every theme and never carry status meaning.
const colorVariables = {
  primary: 'var(--primary-base)', keyword: 'var(--syntax-keyword)', type: 'var(--syntax-type)', function: 'var(--syntax-function)',
  number: 'var(--syntax-number)', string: 'var(--syntax-string)', operator: 'var(--syntax-operator)', variable: 'var(--syntax-variable)',
  success: 'var(--status-success)', comment: 'var(--syntax-comment)',
  // The bold end: the status colours the app already has, and the violet the
  // syntax palette keeps for keywords.
  crimson: 'var(--status-error)', amber: 'var(--status-warning)', azure: 'var(--status-info)', violet: 'var(--syntax-keyword)',
} satisfies Record<FriendColor, string>;
/** CSS value for an avatar color role. */
export const friendColorVariable = (color: FriendColor): string => colorVariables[color];
export const isValidFriendColor = (color: string | null | undefined): color is FriendColor =>
  Boolean(color && (FRIEND_COLORS as readonly string[]).includes(color));

const revisionSchema = z.number().int().nonnegative();
const nameSchema = z.string().trim().min(1).max(32);
const roleSchema = z.string().trim().min(1).max(80);
const v1Schema = z.object({ version: z.literal(1), revision: revisionSchema, aliases: z.array(z.object({ agent: z.string().min(1), name: nameSchema }).strict()).max(128) }).strict();
const friendSchema = z.object({
  agent: z.string().min(1),
  name: nameSchema.optional(),
  role: roleSchema.optional(),
  body: z.enum(FRIEND_BODIES).optional(),
  color: z.enum(FRIEND_COLORS).optional(),
}).strict();
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

export function saveFriendProfile(
  storage: StorageAccess,
  runtime: string,
  agent: string,
  input: { name: string; role?: string } & FriendAppearance,
  revision: number,
): FriendProfiles {
  const current = readFriendProfiles(storage, runtime);
  if (current.revision !== revision) throw new FriendRevisionConflict();
  const trimmedRole = input.role?.trim();
  const entry = {
    agent,
    name: input.name,
    ...(trimmedRole ? { role: trimmedRole } : {}),
    body: input.body,
    color: input.color,
  };
  const next = profileSchema.parse({ ...current, revision: current.revision + 1, friends: [...current.friends.filter(item => item.agent !== agent), entry] });
  storage.setItem(profileKey(runtime), JSON.stringify(next));
  return next;
}

const familiarNames = new Map([['manager', 'Milo'], ['explore', 'Sage'], ['build', 'Pip'], ['operator', 'CarterBot'], ['zdr', 'Vera']]);
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

// ---------------------------------------------------------------------------
// 1-to-1 Folder = Friend model & Guardrails
// ---------------------------------------------------------------------------

export function normalizeFolderKeyPath(directory: string): string {
  return directory.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
}

/** Storage key for a folder's unified Friend identity inside `FriendProfiles`. */
export function folderFriendKey(directory: string): string {
  return `folder:${normalizeFolderKeyPath(directory)}`;
}

export function folderFriendAppearance(
  profiles: FriendProfiles | null,
  directory: string,
  projectColor?: string | null,
  fallbackAgent?: string,
): FriendAppearance {
  const key = folderFriendKey(directory);
  const savedFolder = profiles?.friends.find(item => item.agent === key);
  const savedAgent = fallbackAgent ? profiles?.friends.find(item => item.agent === fallbackAgent) : undefined;
  const fallback = defaultFriendAppearance(key);
  const defaultColor = isValidFriendColor(projectColor) ? projectColor : (savedAgent?.color ?? fallback.color);
  return {
    body: savedFolder?.body ?? savedAgent?.body ?? fallback.body,
    color: savedFolder?.color ?? defaultColor,
  };
}

export function folderFriendName(
  profiles: FriendProfiles | null,
  project: { path: string; label?: string },
  fallbackAgent?: Pick<Agent, 'name' | 'displayName'> | null,
): string {
  const key = folderFriendKey(project.path);
  const saved = profiles?.friends.find(item => item.agent === key)?.name;
  if (saved) return saved;
  const label = project.label?.trim() || project.path.split(/[\\/]+/).filter(Boolean).pop() || project.path;
  if (label) return label;
  return fallbackAgent ? friendName(profiles, fallbackAgent) : 'Friend';
}

export function folderFriendRole(
  profiles: FriendProfiles | null,
  project: { path: string; label?: string },
  primaryAgent?: Pick<Agent, 'name' | 'displayName' | 'description'> | null,
  guardrails?: Pick<FolderGuardrailState, 'zdrLocked' | 'computerUse'>,
): string {
  const key = folderFriendKey(project.path);
  const savedRole = profiles?.friends.find(item => item.agent === key)?.role;
  if (savedRole) return savedRole;
  if (guardrails?.zdrLocked || primaryAgent?.name === 'zdr') {
    return 'ZDR Legal · Strict Zero Retention';
  }
  const agentName = primaryAgent?.name?.toLowerCase();
  if (agentName === 'chatgpt') return 'ChatGPT · OpenAI';
  if (agentName === 'claude') return 'Claude · Claude Code';
  if (agentName === 'operator') {
    return guardrails?.computerUse === 'deny'
      ? 'Operator · Local Workspace'
      : 'Operator · Smart Capabilities & Computer Use';
  }
  return primaryAgent?.displayName || 'Operator · Smart Capabilities';
}

type RuleLike = { action?: string; resource?: string; effect?: string };
type ConfigLike = {
  config?: { default_agent?: string };
  ruleSources?: ReadonlyArray<{
    policies?: ReadonlyArray<RuleLike>;
    permissions?: ReadonlyArray<RuleLike>;
  }>;
};

const extractAllowedProviders = (configuration?: ConfigLike, directory?: string): string[] => {
  const policies = (configuration?.ruleSources ?? [])
    .flatMap(source => source.policies ?? [])
    .filter(p => p.action === 'provider.use');
  const deniesAll = policies.some(p => p.effect === 'deny' && p.resource === '*');
  if (deniesAll) {
    const allowed = [...new Set(
      policies
        .filter(p => p.effect === 'allow' && p.resource && p.resource !== '*')
        .map(p => String(p.resource)),
    )];
    if (allowed.length > 0) return allowed;
  }
  return providerBindingFromFolderName(directory) ?? [];
};

/**
 * Resolves the primary Friend agent for a folder.
 * Every folder defaults to `operator` (all capabilities built in, launched on demand)
 * unless the folder is ZDR-locked (`zdr`), provider-bound (`Claude`/`ChatGPT`), or
 * explicitly configured with a custom primary agent.
 */
export function resolveFolderPrimaryAgent(
  project: { path: string; label?: string; defaultAgent?: string },
  agents: readonly Agent[],
  configuration?: ConfigLike,
): Agent | undefined {
  const visiblePrimary = agents.filter(item => !item.hidden && item.mode !== 'subagent');
  if (visiblePrimary.length === 0) return agents.find(item => !item.hidden);

  const allowedProviders = extractAllowedProviders(configuration, project.path);
  const isZdrFolder = (allowedProviders.length === 1 && allowedProviders[0] === 'openrouter-zdr')
    || /\bzdr\b/i.test(project.path)
    || /^\s*zdr\b/i.test(project.label ?? '');

  if (isZdrFolder) {
    const zdrAgent = visiblePrimary.find(item => item.name.toLowerCase() === 'zdr');
    if (zdrAgent) return zdrAgent;
  }

  const configuredName = project.defaultAgent?.trim() || configuration?.config?.default_agent?.trim();
  if (configuredName) {
    const exact = visiblePrimary.find(item => item.name === configuredName)
      ?? visiblePrimary.find(item => item.name.toLowerCase() === configuredName.toLowerCase());
    if (exact) {
      return exact;
    }
  }

  if (allowedProviders.includes('claude-code')) {
    const claudeAgent = visiblePrimary.find(item => item.name.toLowerCase() === 'claude');
    if (claudeAgent) return claudeAgent;
  }
  if (allowedProviders.length === 1 && allowedProviders[0] === 'openai' && /open carter[\\/]chatgpt$/i.test(project.path)) {
    const chatgptAgent = visiblePrimary.find(item => item.name.toLowerCase() === 'chatgpt');
    if (chatgptAgent) return chatgptAgent;
  }

  return visiblePrimary.find(item => item.name === 'operator')
    ?? (configuredName ? visiblePrimary.find(item => item.name === configuredName) : undefined)
    ?? visiblePrimary.find(item => item.name === 'manager')
    ?? visiblePrimary.find(item => item.name === 'build')
    ?? visiblePrimary[0];
}

/** Specialist subagents available in this folder (tucked inside the Friend's Studio panel). */
export function resolveFolderSpecialists(
  agents: readonly Agent[],
  primaryAgentName?: string,
  zdrLocked = false,
): Agent[] {
  if (zdrLocked) return [];
  return agents.filter(item => !item.hidden && item.name !== primaryAgentName && item.mode === 'subagent');
}

const lastEffectFor = (
  rules: readonly RuleLike[],
  actions: readonly string[],
  fallback: FolderGuardrailEffect,
): FolderGuardrailEffect => {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (!rule?.action || !rule?.effect) continue;
    if (actions.includes(rule.action) && (rule.effect === 'allow' || rule.effect === 'ask' || rule.effect === 'deny')) {
      return rule.effect;
    }
  }
  return fallback;
};

/** Summarizes the effective guardrails for a folder from its OpenCode config + primary agent. */
export function summarizeFolderGuardrails(
  configuration?: ConfigLike,
  primaryAgent?: Pick<Agent, 'name' | 'permissions'>,
  directory?: string,
): FolderGuardrailsSummary {
  const allowedProviders = extractAllowedProviders(configuration, directory);
  const zdrLocked = (allowedProviders.length === 1 && allowedProviders[0] === 'openrouter-zdr')
    || primaryAgent?.name === 'zdr'
    || Boolean(directory && providerBindingFromFolderName(directory)?.includes('openrouter-zdr'));

  const folderPermissions = (configuration?.ruleSources ?? []).flatMap(source => source.permissions ?? []);
  const allPermissions = [...folderPermissions, ...(primaryAgent?.permissions ?? [])];

  if (zdrLocked) {
    return {
      zdrLocked: true,
      allowedProviders: ['openrouter-zdr'],
      computerUse: 'deny',
      macControl: 'deny',
      browserControl: 'deny',
      webAccess: 'deny',
      fileAndShell: lastEffectFor(folderPermissions, ['edit', 'shell'], 'ask'),
      externalDirectory: 'deny',
      subagents: 'deny',
      badges: ['ZDR Locked', 'Local Only'],
    };
  }

  const computerUse = lastEffectFor(allPermissions, ['carterbot_*', 'carterbot_approved_click', 'carterbot_mac_*'], 'ask');
  const macControl = lastEffectFor(allPermissions, ['control-mac_*'], 'ask');
  const browserControl = lastEffectFor(allPermissions, ['playwright_*', 'control-chrome_*', 'chrome-devtools_*'], 'ask');
  const webAccess = lastEffectFor(allPermissions, ['websearch', 'webfetch'], 'allow');
  const fileAndShell = lastEffectFor(allPermissions, ['edit', 'shell'], 'ask');
  const externalDirectory = lastEffectFor(allPermissions, ['external_directory'], 'ask');
  const subagents = lastEffectFor(allPermissions, ['subagent'], 'allow');

  const badges: string[] = [];
  if (allowedProviders.length > 0) {
    badges.push(allowedProviders.join(' + '));
  }
  if (computerUse !== 'deny') {
    badges.push('Virtual Computer');
  } else {
    badges.push('No Virtual Computer');
  }
  if (externalDirectory === 'deny') {
    badges.push('Folder Confined');
  }
  if (webAccess === 'deny') {
    badges.push('Offline');
  }

  return {
    zdrLocked: false,
    allowedProviders,
    computerUse,
    macControl,
    browserControl,
    webAccess,
    fileAndShell,
    externalDirectory,
    subagents,
    badges,
  };
}

type GuardrailConfiguration = {
  policies: Array<{ resource: string; effect: 'allow' | 'deny' }>;
  permissions: Array<{ action: string; resource: string; effect: FolderGuardrailEffect }>;
};

/** Converts the unified Guardrail toggles into canonical OpenCode `policies` and `permissions`. */
export function buildGuardrailPoliciesAndPermissions(
  state: FolderGuardrailState,
  existingPermissions: ReadonlyArray<{ action: string; resource: string; effect: FolderGuardrailEffect }> = [],
  previousState?: FolderGuardrailState,
): GuardrailConfiguration {
  // A brain-only save must not flatten granular folder permissions. Replace a
  // capability's rules only when the user changed that capability.
  const changed = new Set<string>();
  const groups: Array<[keyof Omit<FolderGuardrailState, 'zdrLocked' | 'allowedProviders'>, string[]]> = [
    ['computerUse', ['carterbot_*', 'carterbot_mac_*', 'carterbot_approved_click', 'carterbot_mac_save_routine']],
    ['macControl', ['control-mac_*']],
    ['browserControl', ['playwright_*', 'control-chrome_*', 'chrome-devtools_*']],
    ['webAccess', ['websearch', 'webfetch']],
    ['fileAndShell', ['edit', 'shell']],
    ['externalDirectory', ['external_directory']],
    ['subagents', ['subagent']],
  ];
  for (const [key, actions] of groups) {
    if (!previousState || (state.zdrLocked && key !== 'fileAndShell') || state.zdrLocked !== previousState.zdrLocked || state[key] !== previousState[key]) {
      for (const action of actions) changed.add(action);
    }
  }
  const preserved = existingPermissions.filter(rule => !changed.has(rule.action));

  if (state.zdrLocked) {
    return {
      policies: [
        { resource: '*', effect: 'deny' },
        { resource: 'openrouter-zdr', effect: 'allow' },
      ],
      permissions: [
        ...preserved,
        ...([
        { action: 'carterbot_*', resource: '*', effect: 'deny' },
        { action: 'carterbot_mac_*', resource: '*', effect: 'deny' },
        { action: 'playwright_*', resource: '*', effect: 'deny' },
        { action: 'chrome-devtools_*', resource: '*', effect: 'deny' },
        { action: 'control-chrome_*', resource: '*', effect: 'deny' },
        { action: 'control-mac_*', resource: '*', effect: 'deny' },
        { action: 'websearch', resource: '*', effect: 'deny' },
        { action: 'webfetch', resource: '*', effect: 'deny' },
        { action: 'external_directory', resource: '*', effect: 'deny' },
        { action: 'subagent', resource: '*', effect: 'deny' },
        { action: 'edit', resource: '*', effect: state.fileAndShell },
        { action: 'shell', resource: '*', effect: state.fileAndShell },
        ] satisfies Array<{ action: string; resource: string; effect: FolderGuardrailEffect }>).filter(rule => changed.has(rule.action)),
      ],
    };
  }

  const policies: Array<{ resource: string; effect: 'allow' | 'deny' }> = state.allowedProviders.length > 0
    ? [
        { resource: '*', effect: 'deny' },
        ...state.allowedProviders.map(resource => ({ resource, effect: 'allow' as const })),
      ]
    : [];

  const permissions: Array<{ action: string; resource: string; effect: FolderGuardrailEffect }> = [
    { action: 'carterbot_*', resource: '*', effect: state.computerUse },
    { action: 'carterbot_mac_*', resource: '*', effect: state.computerUse },
    { action: 'carterbot_approved_click', resource: '*', effect: state.computerUse === 'deny' ? 'deny' : 'ask' },
    { action: 'carterbot_mac_save_routine', resource: '*', effect: state.computerUse === 'deny' ? 'deny' : 'ask' },
    { action: 'control-mac_*', resource: '*', effect: state.macControl },
    { action: 'playwright_*', resource: '*', effect: state.browserControl },
    { action: 'control-chrome_*', resource: '*', effect: state.browserControl },
    { action: 'chrome-devtools_*', resource: '*', effect: state.browserControl },
    { action: 'websearch', resource: '*', effect: state.webAccess },
    { action: 'webfetch', resource: '*', effect: state.webAccess },
    { action: 'edit', resource: '*', effect: state.fileAndShell },
    { action: 'shell', resource: '*', effect: state.fileAndShell },
    { action: 'external_directory', resource: '*', effect: state.externalDirectory },
    { action: 'subagent', resource: '*', effect: state.subagents },
  ];

  return { policies, permissions: [...preserved, ...permissions.filter(rule => changed.has(rule.action))] };
}

export const OPEN_FRIEND_STUDIO_EVENT = 'open-carter:open-friend-studio';
export type OpenFriendStudioDetail = { projectId: string; origin?: DOMRect | null };

export function openFolderFriendStudio(projectId: string, origin: DOMRect | null = null): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<OpenFriendStudioDetail>(OPEN_FRIEND_STUDIO_EVENT, {
    detail: { projectId, origin },
  }));
}

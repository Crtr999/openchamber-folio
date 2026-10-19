import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AiTaskSetupError } from './executor.js';

const modelReference = z.object({ providerID: z.string().min(1).regex(/^[^/#*?]+$/), id: z.string().min(1).regex(/^[^#*?]+$/) }).strict();
const capability = z.enum(['read-project', 'read-output', 'fetch-reference', 'draft-output', 'safe-compute']);
const capabilities = z.array(capability).min(1).max(5).refine((items) => new Set(items).size === items.length);
const specialist = z.object({ id: z.string().min(1).regex(/^[^*?]+$/), capabilities }).strict();
export const teamPolicySchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), manager: z.literal('manager'), providers: z.array(z.string().min(1)).min(1), specialists: z.array(z.string().min(1)).max(4) }).strict(),
  z.object({ version: z.literal(2), manager: z.literal('manager'), model: modelReference, freeOnly: z.literal(true), paidFallback: z.literal(false),
    // Additional reviewed models a task may choose. Each must still price at zero,
    // or be an explicitly reviewed flat-subscription model with no metered price.
    models: z.array(modelReference.extend({ billing: z.literal('subscription').optional() }).strict()).max(64).optional(),
    specialists: z.array(specialist).max(4).refine((items) => new Set(items.map((item) => item.id)).size === items.length && items.every((item) => item.id !== 'manager')) }).strict(),
]);

/** The policy default first, then reviewed alternatives, without duplicates. */
export const approvedTeamModels = (policy) => [policy.model, ...(policy.models ?? [])]
  .filter((item, index, items) => items.findIndex((other) => sameTeamModel(other, item)) === index);

// V2.0.18 Model.Info.cost is an array, not a single price. Unknown new cost
// fields must block dispatch until their billing meaning has been reviewed.
const zeroCost = z.object({ tier: z.object({ type: z.literal('context'), size: z.number().int().positive() }).strict().optional(),
  input: z.literal(0), output: z.literal(0), cache: z.object({ read: z.literal(0), write: z.literal(0) }).strict() }).strict();
const freeModel = z.object({ providerID: z.string(), id: z.string(), enabled: z.literal(true), capabilities: z.object({ tools: z.literal(true) }),
  cost: z.array(zeroCost).min(1).refine((items) => items.some((item) => !item.tier)) });

// A subscription model is unpriced, never zero-priced: any listed price means metered billing.
const subscriptionModel = freeModel.extend({ cost: z.array(z.never()).length(0) });

export const isCatalogZeroCostOpenCodeModel = (entry) => entry?.providerID === 'opencode' && freeModel.safeParse(entry).success;

export const discoverCatalogFreeModels = (catalog, policy) => {
  const base = approvedTeamModels(policy);
  const parsed = z.object({ data: z.array(z.object({ providerID: z.string(), id: z.string() }).passthrough()) }).safeParse(catalog);
  if (!parsed.success || !policy.freeOnly) return base;
  const discovered = parsed.data.data
    .filter((entry) => isCatalogZeroCostOpenCodeModel(entry))
    .map((entry) => ({ providerID: entry.providerID, id: entry.id }));
  return [...base, ...discovered]
    .filter((item, index, items) => items.findIndex((other) => sameTeamModel(other, item)) === index);
};

export function validateFreeModel(catalog, selected) {
  const parsed = z.object({ data: z.array(z.object({ providerID: z.string(), id: z.string() }).passthrough()) }).safeParse(catalog);
  if (!parsed.success) throw new AiTaskSetupError('teamProvider');
  const matches = parsed.data.data.filter((entry) => sameTeamModel(entry, selected));
  if (matches.length !== 1) throw new AiTaskSetupError('teamProvider');
  const result = (selected.billing === 'subscription' ? subscriptionModel : freeModel).safeParse(matches[0]);
  if (!result.success) throw new AiTaskSetupError('teamProvider');
  return result.data;
}

export const sameTeamModel = (actual, selected) => actual?.providerID === selected.providerID && actual?.id === selected.id && (!actual.variant || actual.variant === 'default');

const permissionMatches = (pattern, value) => new RegExp(`^${pattern.split('*').map((part) => part.split('?').map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.')).join('.*')}$`).test(value);
export const permissionEffect = (rules, action, resource) => rules.filter((rule) => permissionMatches(rule.action, action) && permissionMatches(rule.resource, resource)).at(-1)?.effect ?? 'ask';

export function capabilityRules(items) {
  const rules = [];
  if (items.includes('read-project')) {
    // Internal read resources are Location-relative. Deny normalized traversal
    // into the surrounding worktree as well as explicit absolute references.
    rules.push({ action: 'read', resource: '*', effect: 'ask' });
  }
  if (items.includes('draft-output')) rules.push({ action: 'team_output', resource: '*', effect: 'ask' });
  if (items.includes('read-output')) rules.push({ action: 'team_read_output', resource: '*', effect: 'ask' });
  if (items.includes('safe-compute')) rules.push({ action: 'team_compute', resource: '*', effect: 'ask' });
  if (items.includes('fetch-reference')) rules.push({ action: 'webfetch', resource: '*', effect: 'ask' });
  return rules;
}

export const confinementRules = [
  { action: 'read', resource: '../*', effect: 'deny' },
  { action: 'read', resource: '/*', effect: 'deny' },
  { action: 'read', resource: '?:/*', effect: 'deny' },
  { action: 'external_directory', resource: '*', effect: 'deny' },
];

export function validateCapabilityProfile(agent, items, selected, delegates = []) {
  if (!agent || !agent.steps || agent.steps > 20 || !sameTeamModel(agent.model ?? selected, selected)) return false;
  const reset = agent.permissions.findLastIndex((rule) => rule.action === '*' && rule.resource === '*' && rule.effect === 'deny');
  if (reset < 0) return false;
  const allowed = [...capabilityRules(items), ...delegates.map((id) => ({ action: 'subagent', resource: id }))];
  if (!agent.permissions.slice(reset + 1).every((rule) => rule.effect === 'deny'
    || allowed.some((grant) => rule.action === grant.action && rule.resource === grant.resource
      && (rule.effect === 'ask' || rule.effect === 'allow' && ['team_compute', 'team_output', 'team_read_output', 'subagent'].includes(rule.action))))) return false;
  return confinementRules.every((rule) => agent.permissions.some((item) => item.action === rule.action && item.resource === rule.resource && item.effect === 'deny')
    && permissionEffect(agent.permissions, rule.action, rule.resource) === 'deny');
}

const confined = (directory, target) => {
  const relative = path.relative(directory, target);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export async function validateOutputDirectory(directory) {
  const target = path.join(directory, 'team-output');
  try {
    if (await realpath(target) !== target || !(await stat(target)).isDirectory()) throw new AiTaskSetupError('teamPolicy');
  } catch { throw new AiTaskSetupError('teamPolicy'); }
}

export async function verifyTeamArtifact(directory, file) {
  const target = path.resolve(directory, file);
  if (!confined(directory, target)) throw new AiTaskSetupError('teamScope');
  let canonical;
  try { canonical = await realpath(target); }
  catch { throw new AiTaskSetupError('teamScope'); }
  if (!confined(directory, canonical)) throw new AiTaskSetupError('teamScope');
  let handle;
  try {
    handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile()) throw new AiTaskSetupError('teamScope');
    const hash = createHash('sha256');
    let sizeBytes = 0;
    for await (const bytes of handle.createReadStream({ autoClose: false })) {
      hash.update(bytes);
      sizeBytes += bytes.length;
    }
    const after = await handle.stat();
    const current = await stat(target);
    if (await realpath(target) !== canonical || before.dev !== current.dev || before.ino !== current.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new AiTaskSetupError('teamScope');
    return { path: target, label: path.relative(directory, target), verified: true, sha256: hash.digest('hex'), sizeBytes };
  } catch { throw new AiTaskSetupError('teamScope'); }
  finally { await handle?.close(); }
}

import { describe, expect, it } from 'vitest';
import { teamPolicySchema, validateFreeModel, validateCapabilityProfile, capabilityRules, confinementRules, permissionEffect } from './team-policy.js';

const selected = { providerID: 'opencode', id: 'exact-free' };
const zero = () => ({ input: 0, output: 0, cache: { read: 0, write: 0 } });
const model = () => ({ ...selected, enabled: true, capabilities: { tools: true }, cost: [zero(), { ...zero(), tier: { type: 'context', size: 200_000 } }] });
const policy = () => ({ version: 2, manager: 'manager', model: selected, freeOnly: true, paidFallback: false, specialists: [{ id: 'writer', capabilities: ['read-project', 'draft-output'] }] });

describe('exact free-model catalog proof', () => {
  it('requires an exact enabled tool-capable model and complete zero base/cache/tier prices', () => {
    expect(validateFreeModel({ data: [model()] }, selected)).toMatchObject({ ...selected, cost: model().cost });
    for (const field of ['input', 'output', 'read', 'write']) {
      for (const tier of [0, 1]) {
        const entry = model();
        if (field === 'input' || field === 'output') entry.cost[tier][field] = 0.01;
        else entry.cost[tier].cache[field] = 0.01;
        expect(() => validateFreeModel({ data: [entry] }, selected)).toThrow();
      }
    }
  });
  it('fails closed on unknown, missing, empty, malformed, disabled or ambiguous catalog evidence', () => {
    for (const entry of [
      { ...model(), enabled: false }, { ...model(), enabled: undefined }, { ...model(), capabilities: { tools: false } },
      { ...model(), capabilities: undefined }, { ...model(), cost: undefined }, { ...model(), cost: [] },
      { ...model(), cost: [{ input: 0, output: 0 }] }, { ...model(), cost: [{ ...zero(), cache: { read: 0 } }] },
      { ...model(), cost: [{ ...zero(), reasoning: 1 }] }, { ...model(), cost: [{ ...zero(), input: '0' }] },
      { ...model(), cost: [{ ...zero(), input: NaN }] }, { ...model(), cost: [{ ...zero(), input: -1 }] },
      { ...model(), cost: [{ ...zero(), input: Infinity }] }, { ...model(), cost: [model().cost[1]] },
      { ...model(), cost: [{ ...zero(), tier: { type: 'unknown', size: 100 } }] },
    ]) expect(() => validateFreeModel({ data: [entry] }, selected)).toThrow();
    for (const data of [[], [model(), model()], [{ ...model(), id: 'exact-free:paid' }], [{ ...model(), providerID: 'other' }]]) {
      expect(() => validateFreeModel({ data }, selected)).toThrow();
    }
  });
});

describe('reviewed subscription models', () => {
  it('admits only an unpriced, explicitly reviewed subscription model and refuses any metered price', () => {
    const subscription = { providerID: 'openai', id: 'gpt-sub', billing: 'subscription' };
    const entry = { providerID: 'openai', id: 'gpt-sub', enabled: true, capabilities: { tools: true }, cost: [] };
    expect(validateFreeModel({ data: [entry] }, subscription)).toMatchObject({ providerID: 'openai', id: 'gpt-sub' });
    expect(() => validateFreeModel({ data: [entry] }, { providerID: 'openai', id: 'gpt-sub' })).toThrow();
    expect(() => validateFreeModel({ data: [{ ...entry, cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] }] }, subscription)).toThrow();
    expect(() => validateFreeModel({ data: [{ ...entry, cost: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }] }] }, subscription)).toThrow();
    expect(teamPolicySchema.safeParse({ version: 2, manager: 'manager', model: { providerID: 'openrouter', id: 'free' }, models: [subscription], freeOnly: true, paidFallback: false, specialists: [] }).success).toBe(true);
    expect(teamPolicySchema.safeParse({ version: 2, manager: 'manager', model: { providerID: 'openrouter', id: 'free' }, models: [{ ...subscription, billing: 'metered' }], freeOnly: true, paidFallback: false, specialists: [] }).success).toBe(false);
  });
});

describe('versioned team capability profiles', () => {
  it('preapproves only bounded output review while generic scans, shell and config remain denied', () => {
    const permissions = [{ action: '*', resource: '*', effect: 'deny' }, { action: 'team_read_output', resource: '*', effect: 'allow' }, ...confinementRules];
    expect(validateCapabilityProfile({ steps: 8, permissions }, ['read-output'], selected)).toBe(true);
    expect(permissionEffect(permissions, 'team_read_output', 'draft.md')).toBe('allow');
    for (const [action, resource] of [['read', '.'], ['read', '.env'], ['read', '.opencode/opencode.json'], ['read', '/etc/passwd'], ['shell', '*'], ['external_directory', '*']]) {
      expect(permissionEffect(permissions, action, resource)).toBe('deny');
    }
    expect(validateCapabilityProfile({ steps: 8, permissions: [...permissions, { action: 'read', resource: '*', effect: 'allow' }] }, ['read-output'], selected)).toBe(false);
  });
  it('preserves v1 and rejects paid fallback, provider wildcards, variants and unknown capabilities', () => {
    expect(teamPolicySchema.parse({ version: 1, manager: 'manager', providers: ['openai'], specialists: ['reader'] }).version).toBe(1);
    expect(teamPolicySchema.parse(policy()).version).toBe(2);
    for (const invalid of [
      { ...policy(), freeOnly: false }, { ...policy(), paidFallback: true }, { ...policy(), providers: ['*'] },
      { ...policy(), model: { ...selected, variant: 'high' } }, { ...policy(), model: { ...selected, id: 'free#high' } },
      { ...policy(), specialists: [{ id: 'writer', capabilities: ['shell'] }] },
      { ...policy(), specialists: [{ id: 'writer', capabilities: ['read-project', 'read-project'] }] },
      { ...policy(), specialists: [policy().specialists[0], policy().specialists[0]] },
      { ...policy(), specialists: [{ id: 'manager', capabilities: ['read-project'] }] },
    ]) expect(teamPolicySchema.safeParse(invalid).success).toBe(false);
  });
  it('requires default-deny, independent traversal denial and exact model inheritance', () => {
    const permissions = [{ action: '*', resource: '*', effect: 'deny' }, ...capabilityRules(['read-project']), ...confinementRules];
    const agent = { steps: 8, permissions };
    expect(validateCapabilityProfile(agent, ['read-project'], selected)).toBe(true);
    expect(validateCapabilityProfile({ ...agent, model: selected }, ['read-project'], selected)).toBe(true);
    expect(validateCapabilityProfile({ ...agent, model: { ...selected, variant: 'other' } }, ['read-project'], selected)).toBe(false);
    for (let index = 0; index < permissions.length; index++) {
      if (index === 1) continue;
      expect(validateCapabilityProfile({ ...agent, permissions: permissions.filter((_, i) => i !== index) }, ['read-project'], selected)).toBe(false);
    }
    for (const rule of [{ action: 'read', resource: '*', effect: 'allow' }, { action: '*', resource: '*', effect: 'ask' },
      { action: 'shell', resource: 'python *', effect: 'ask' }, { action: 'edit', resource: '*', effect: 'ask' }]) {
      expect(validateCapabilityProfile({ ...agent, permissions: [...permissions, rule] }, ['read-project'], selected)).toBe(false);
    }
  });
});

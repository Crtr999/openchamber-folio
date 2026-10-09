import { describe, expect, test } from 'bun:test';
import { projectRulesConfiguration } from './rules';

describe('rules configuration provenance', () => {
  test('keeps lower-layer restrictions even when later experimental fields replace them', () => {
    const snapshot = projectRulesConfiguration([
      { type: 'document', info: { experimental: { policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }] }, instructions: ['global.md'] } },
      { type: 'document', info: { experimental: { subagent_depth: 3, policies: [{ action: 'provider.use', resource: 'openrouter-zdr', effect: 'allow' }] }, share: 'disabled', instructions: ['local.md'] } },
    ]);
    expect(snapshot.ruleSources.flatMap((source) => source.policies)).toEqual([
      { action: 'provider.use', resource: '*', effect: 'deny' },
      { action: 'provider.use', resource: 'openrouter-zdr', effect: 'allow' },
    ]);
    expect(snapshot.config.share).toBe('disabled');
    expect(snapshot.ruleSources.flatMap((source) => source.instructions)).toEqual(['global.md', 'local.md']);
  });
  test('normalizes both model formats without treating a default as a restriction', () => {
    expect(projectRulesConfiguration([{ type: 'document', info: { model: 'provider/model' } }]).defaultModel).toBe('provider/model');
    expect(projectRulesConfiguration([{ type: 'document', info: { model: { providerID: 'provider', model: 'model' } } }]).defaultModel).toBe('provider/model');
    expect(projectRulesConfiguration([]).defaultModel).toBeUndefined();
  });
  test('does not copy arbitrary configuration or provider credentials into rule sources', () => {
    const snapshot = projectRulesConfiguration([{ type: 'document', info: { username: 'private' } }]);
    expect(snapshot.ruleSources).toEqual([{ path: undefined, policies: [], permissions: [], instructions: [] }]);
  });
});

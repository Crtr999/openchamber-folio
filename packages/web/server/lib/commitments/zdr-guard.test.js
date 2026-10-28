import { describe, expect, it } from 'vitest';
import { createFolderGuard, isZdrNamed } from './zdr-guard.js';

const guard = (providers, excluded = [], { throws = false } = {}) => createFolderGuard({
  resolveAllowedProviders: async () => { if (throws) throw new Error('unreadable'); return providers; },
  readExcludedDirectories: async () => excluded,
});

describe('legal / ZDR guard', () => {
  it('blocks folders bound to the ZDR provider, alone or with others', async () => {
    expect(await guard(['openrouter-zdr']).check('/Users/c/Open Carter/Work')).toEqual({ ok: false, reason: 'zdr-bound' });
    expect(await guard(['openai', 'openrouter-zdr']).check('/Users/c/Work')).toEqual({ ok: false, reason: 'zdr-bound' });
    expect(await guard(['other-ZDR']).check('/Users/c/Work')).toEqual({ ok: false, reason: 'zdr-bound' });
  });

  it('blocks by name even when the binding cannot be read', async () => {
    for (const dir of ['/Users/c/ZDR Legal', '/Users/c/zdr_management', '/x/ZDR/matter']) {
      expect(isZdrNamed(dir)).toBe(true);
      expect((await guard([]).check(dir)).ok).toBe(false);
    }
  });

  it('fails closed on a missing directory or an unreadable binding', async () => {
    expect((await guard([]).check('')).reason).toBe('no-directory');
    expect((await guard([]).check(undefined)).reason).toBe('no-directory');
    expect((await guard([], [], { throws: true }).check('/Users/c/Work')).reason).toBe('binding-unreadable');
  });

  it('honours the user\'s own exclusions including subfolders, not siblings', async () => {
    const g = guard([], ['/Users/c/Private']);
    expect((await g.check('/Users/c/Private')).reason).toBe('excluded');
    expect((await g.check('/Users/c/Private/deep')).reason).toBe('excluded');
    expect((await g.check('/Users/c/PrivateOther')).ok).toBe(true);
  });

  it('allows ordinary and provider-bound non-ZDR folders', async () => {
    expect((await guard([]).check('/Users/c/School')).ok).toBe(true);
    expect((await guard(['claude-code']).check('/Users/c/Open Carter/Claude')).ok).toBe(true);
  });
  it('rejects a bound parent before reading a child configuration', async () => {
    const read = [];
    const g = createFolderGuard({ listProjectPaths: async () => ['/synthetic/private'],
      resolveAllowedProviders: async (directory) => { read.push(directory); return ['openrouter-zdr']; },
    });
    expect(await g.check('/synthetic/private/child')).toEqual({ ok: false, reason: 'zdr-bound' });
    expect(read).toEqual(['/synthetic/private']);
    read.length = 0;
    expect((await g.check('/synthetic/ZDR/matter')).ok).toBe(false);
    expect(read).toEqual([]);
  });
});

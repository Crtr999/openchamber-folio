import { describe, expect, it } from 'vitest';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractAllowedProviders, resolveDirectoryAllowedProviders } from './providers.js';

/**
 * A folder's provider policy is the same policy the server enforces on every
 * send. The capture has to honour it: a folder bound to one provider must not
 * be summarised through another.
 */

const withPolicies = (policies) => ({ experimental: { policies } });

describe('the providers a folder is bound to', () => {
  it('refuses malformed configuration rather than treating it as unbound', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-policy-test-'));
    try {
      fs.writeFileSync(path.join(dir, 'opencode.json'), '{broken');
      await expect(resolveDirectoryAllowedProviders(dir)).rejects.toThrow('Provider policy could not be read');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('reads the allowed provider out of a deny-all policy', () => {
    expect(extractAllowedProviders(withPolicies([
      { action: 'provider.use', resource: '*', effect: 'deny' },
      { action: 'provider.use', resource: 'openrouter-zdr', effect: 'allow' },
    ]))).toEqual(['openrouter-zdr']);
  });

  it('reads every allowed provider when a folder allows several', () => {
    expect(extractAllowedProviders(withPolicies([
      { action: 'provider.use', resource: '*', effect: 'deny' },
      { action: 'provider.use', resource: 'openrouter-zdr', effect: 'allow' },
      { action: 'provider.use', resource: 'openai', effect: 'allow' },
    ]))).toEqual(['openrouter-zdr', 'openai']);
  });

  it('finds nothing when the folder is not bound to one provider', () => {
    expect(extractAllowedProviders(withPolicies([]))).toEqual([]);
    expect(extractAllowedProviders({})).toEqual([]);
    expect(extractAllowedProviders(undefined)).toEqual([]);
    // A policy that allows without denying everything does not bind the
    // folder: anything the folder already uses stays fair game.
    expect(extractAllowedProviders(withPolicies([
      { action: 'provider.use', resource: 'openai', effect: 'allow' },
    ]))).toEqual([]);
  });

  it('ignores policies that are not about providers', () => {
    expect(extractAllowedProviders(withPolicies([
      { action: 'file.read', resource: '*', effect: 'deny' },
      { action: 'provider.use', resource: '*', effect: 'deny' },
      { action: 'provider.use', resource: 'openrouter-zdr', effect: 'allow' },
    ]))).toEqual(['openrouter-zdr']);
  });
});

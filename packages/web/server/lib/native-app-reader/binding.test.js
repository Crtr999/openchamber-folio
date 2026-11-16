import { expect, it } from 'vitest';
import { resolveNativeProviderBinding } from './binding.js';

const session = { model: { providerID: 'fixture', id: 'model' } };
function fixture() {
  const provider = { id: 'fixture', package: 'aisdk:fixture', settings: { baseURL: 'https://approved.invalid/v1', apiKey: 'synthetic-not-a-key' } };
  const model = { id: 'model', providerID: 'fixture', settings: {} };
  const config = { mergedConfig: {} };
  let calls = 0;
  const getClient = () => ({ provider: { list: async () => { calls++; return { data: [provider] }; } }, model: { list: async () => ({ data: [model] }) } });
  const resolve = () => resolveNativeProviderBinding('/synthetic/General', session, { readLayers: () => config, getClient });
  return { provider, model, config, resolve, calls: () => calls };
}
it('binds the running provider endpoint and model overrides without exposing configuration or credentials', async () => {
  const f = fixture(); const initial = await f.resolve(); expect(initial).toMatch(/^[a-f0-9]{64}$/);
  f.provider.settings.baseURL = 'https://changed.invalid/v1'; expect(await f.resolve()).not.toBe(initial);
  f.provider.settings.baseURL = 'https://approved.invalid/v1'; expect(await f.resolve()).toBe(initial);
  f.model.settings.baseURL = 'https://model-override.invalid/v1'; expect(await f.resolve()).not.toBe(initial);
  expect(initial).not.toContain('synthetic-not-a-key');
});
it('refuses ZDR-bound directory policy at the owning boundary before provider queries', async () => {
  const f = fixture(); f.config.mergedConfig.experimental = { policies: [
    { action: 'provider.use', resource: '*', effect: 'deny' },
    { action: 'provider.use', resource: 'openrouter-zdr', effect: 'allow' },
  ] };
  await expect(f.resolve()).rejects.toMatchObject({ statusCode: 403 }); expect(f.calls()).toBe(0);
});
it('refuses unverifiable provider/model/configuration rather than granting a generic provider ID', async () => {
  const f = fixture(); f.provider.id = 'other'; await expect(f.resolve()).rejects.toThrow('cannot verify');
  const g = fixture(); g.model.id = 'other'; await expect(g.resolve()).rejects.toThrow('cannot verify');
  const h = fixture(); h.config.mergedConfig = null; await expect(h.resolve()).rejects.toThrow('cannot verify');
});
it('does not leak configuration or upstream errors into agent results', async () => {
  await expect(resolveNativeProviderBinding('/synthetic/General', session, {
    readLayers: () => { throw new Error('SYNTHETIC_SECRET_DO_NOT_RETURN'); },
  })).rejects.toThrow('Native reader cannot verify the active provider configuration.');
});

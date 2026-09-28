import { describe, expect, test } from 'bun:test';

import { useFolioAskModelStore } from './ask';
import {
  askModelLabel,
  askModelRef,
  askVariantIds,
  nextAskVariant,
  resolveAskModel,
  type AskModelProvider,
} from './ask-model';

const model = (id: string, name: string, variants: string[]): AskModelProvider['models'][number] => ({
  id,
  modelID: id,
  providerID: 'openrouter',
  name,
  capabilities: { tools: true, input: ['text'], output: ['text'] },
  variants: variants.map((entry) => ({ id: entry })),
  time: { released: 0 },
  cost: [],
  status: 'active',
  enabled: true,
  limit: { context: 1000, output: 1000 },
});

const provider = (id: string, name: string, models: AskModelProvider['models']): AskModelProvider => ({
  id,
  name,
  activation: 'auto',
  package: '@ai-sdk/openai-compatible',
  models,
});

const catalog: AskModelProvider[] = [
  provider('opencode', 'OpenCode Zen', [model('big-pickle', 'Big Pickle', [])]),
  provider('openrouter', 'OpenRouter', [model('stealth/space-bunny-alpha', 'Space Bunny Alpha', ['low', 'high', 'max'])]),
];

const appSelection = { providerID: 'openrouter', modelID: 'stealth/space-bunny-alpha', variant: 'max' };

describe('the model Ask AI sends on', () => {
  test('is the model picked in the panel, not whatever the chat beside it moved to', () => {
    // The failure this fixes: a model change made in an ordinary chat silently
    // re-pointed every page conversation, with no switcher to move it back.
    const picked = resolveAskModel({ providerID: 'opencode', modelID: 'big-pickle' }, { providerID: 'openrouter', modelID: 'stealth/space-bunny-alpha', variant: 'max' });
    expect(picked).toEqual({ providerID: 'opencode', modelID: 'big-pickle', variant: undefined });
    expect(askModelRef(catalog, picked!)).toEqual({ providerID: 'opencode', id: 'big-pickle' });
  });

  test("follows the app's selection until the user picks one here", () => {
    expect(resolveAskModel(undefined, appSelection)).toEqual(appSelection);
  });

  test('is nothing when neither the panel nor the app has a model', () => {
    expect(resolveAskModel(undefined, {})).toBeUndefined();
    expect(resolveAskModel({ providerID: '', modelID: '' }, {})).toBeUndefined();
  });

  test('carries the model identifiers, never the name the trigger shows', () => {
    // "Big Pickle" is a label. Sending it where OpenCode expects a model id is a
    // request the provider cannot resolve, so the label must not travel.
    const selection = resolveAskModel({ providerID: 'opencode', modelID: 'big-pickle' }, appSelection);
    const ref = askModelRef(catalog, selection!);
    expect(askModelLabel(catalog, selection)).toBe('Big Pickle');
    expect(ref.providerID).toBe('opencode');
    expect(ref.id).toBe('big-pickle');
    expect(Object.values(ref)).not.toContain('Big Pickle');
  });

  test('falls back to the identifier before the catalog has the name', () => {
    expect(askModelLabel(catalog, { providerID: 'opencode', modelID: 'not-loaded-yet' })).toBe('not-loaded-yet');
  });

  test('sends only a thinking level the model declares', () => {
    const undeclared = { providerID: 'opencode', modelID: 'big-pickle', variant: 'max' };
    expect(askVariantIds(catalog, undeclared)).toEqual([]);
    expect(askModelRef(catalog, undeclared)).toEqual({ providerID: 'opencode', id: 'big-pickle' });
  });

  test('keeps a thinking level the model does declare', () => {
    const declared = { providerID: 'openrouter', modelID: 'stealth/space-bunny-alpha', variant: 'high' };
    expect(askVariantIds(catalog, declared)).toEqual(['low', 'high', 'max']);
    expect(askModelRef(catalog, declared)).toEqual({ providerID: 'openrouter', id: 'stealth/space-bunny-alpha', variant: 'high' });
  });

  test('cycles the thinking level through no level and wraps at both ends', () => {
    expect(nextAskVariant(['low', 'high'], undefined, 1)).toBe('low');
    expect(nextAskVariant(['low', 'high'], 'low', 1)).toBe('high');
    expect(nextAskVariant(['low', 'high'], 'high', 1)).toBeUndefined();
    expect(nextAskVariant(['low', 'high'], undefined, -1)).toBe('high');
  });
});

describe('the Ask AI model choice', () => {
  test('outlives a change to the model the rest of the app is on', () => {
    const store = useFolioAskModelStore;
    const before = store.getState().selection;
    store.getState().setModel('opencode', 'big-pickle');
    const picked = store.getState().selection;
    // Whatever an ordinary chat does afterwards, the page conversation keeps
    // the model that was chosen for it.
    store.getState().setModel('openrouter', 'stealth/space-bunny-alpha', 'max');
    expect(store.getState().selection).toEqual({ providerID: 'openrouter', modelID: 'stealth/space-bunny-alpha', variant: 'max' });
    expect(picked).toEqual({ providerID: 'opencode', modelID: 'big-pickle' });
    store.setState({ selection: before });
  });

  test('a thinking level chosen here travels with the model, and is the value sent', () => {
    const store = useFolioAskModelStore;
    const before = store.getState().selection;
    store.getState().setModel('openrouter', 'stealth/space-bunny-alpha', 'max');
    store.getState().setModel('openrouter', 'stealth/space-bunny-alpha', undefined);
    const cleared = store.getState().selection!;
    expect(cleared).toEqual({ providerID: 'openrouter', modelID: 'stealth/space-bunny-alpha' });
    expect(askModelRef(catalog, cleared)).toEqual({ providerID: 'openrouter', id: 'stealth/space-bunny-alpha' });
    store.setState({ selection: before });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../session-assist/context.js', () => ({
  loadSettledTurns: vi.fn(async () => [{ user: { text: 'my paper is due Friday' }, assistant: { id: 'm1', text: 'ok' } }]),
}));
const { createCommitmentCapture } = await import('./capture-runtime.js');
const { createFolderGuard } = await import('./zdr-guard.js');
const { parseCommitmentsState } = await import('./store.js');

const NOW = Date.UTC(2026, 9, 22, 15, 0);

const fixture = ({ providers = [], text, settings = {}, items = [] } = {}) => {
  let state = parseCommitmentsState({ version: 1, settings: { timezone: 'America/New_York', ...settings }, items });
  const store = { read: async () => state, update: async (change) => { state = parseCommitmentsState(await change(state)); return state; } };
  const client = {
    session: { get: vi.fn(async () => ({ id: 'ses' })) },
    message: { list: vi.fn() },
  };
  const generate = vi.fn(async () => ({ text: text ?? JSON.stringify({ commitments: [{ title: 'Finish paper', due: '2026-10-30' }] }) }));
  const onChanged = vi.fn();
  const capture = createCommitmentCapture({
    buildOpenCodeUrl: () => 'http://localhost:1/', getOpenCodeAuthHeaders: () => ({}),
    getSmallModelService: async () => ({
      describeSmallModel: async () => ({ providerID: 'prov', modelID: 'small', inputCharBudget: 20_000 }),
      generateSmallModelText: generate,
    }),
    store,
    guard: createFolderGuard({ resolveAllowedProviders: async () => providers }),
    resolveAllowedProviders: async () => providers,
    readSessionMetadata: async () => ({}),
    createClient: () => client, onChanged, quietMs: 5, now: () => NOW,
    logger: { log: () => {}, warn: () => {} },
  });
  const run = async (directory) => {
    capture.processPayload({ type: 'session.idle', properties: { sessionID: 'ses', directory } }, '');
    await vi.advanceTimersByTimeAsync(50);
  };
  return { capture, client, generate, onChanged, run, get state() { return state; } };
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('commitment capture', () => {
  it('adds a noticed deadline as an auto item, once', async () => {
    const f = fixture();
    await f.run('/Users/c/School');
    expect(f.state.items).toHaveLength(1);
    expect(f.state.items[0]).toMatchObject({ title: 'Finish paper', origin: 'auto', sourceSessionId: 'ses', sourceDirectory: '/Users/c/School', confirmedAt: null });
    expect(f.onChanged).toHaveBeenCalledTimes(1);
    await f.run('/Users/c/School'); // cursor: nothing new to read
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it('never reads a legal/ZDR folder: no messages fetched, no model call', async () => {
    for (const [directory, providers] of [['/Users/c/ZDR Legal', []], ['/Users/c/Work', ['openrouter-zdr']]]) {
      const f = fixture({ providers });
      await f.run(directory);
      expect(f.client.session.get).not.toHaveBeenCalled();
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.state.items).toEqual([]);
    }
  });

  it('does nothing when tracking is off', async () => {
    const f = fixture({ settings: { enabled: false } });
    await f.run('/Users/c/School');
    expect(f.generate).not.toHaveBeenCalled();
  });

  it('does not summarise a provider-bound folder through another provider', async () => {
    const f = fixture({ providers: ['claude-code'] });
    await f.run('/Users/c/Open Carter/Claude');
    expect(f.generate).not.toHaveBeenCalled();
  });

  it('does not re-add a deadline the user finished or removed', async () => {
    const f = fixture({ items: [{ id: 'x', title: 'Finish the paper', dueAt: Date.UTC(2026, 9, 31, 3, 59), status: 'dismissed', origin: 'auto', createdAt: 1, updatedAt: 1 }] });
    await f.run('/Users/c/School');
    expect(f.state.items).toHaveLength(1);
    expect(f.onChanged).not.toHaveBeenCalled();
  });

  it('ignores its own check sessions and survives bad model output', async () => {
    const own = fixture();
    own.capture = undefined;
    const bad = fixture({ text: 'not json' });
    await bad.run('/Users/c/School');
    expect(bad.state.items).toEqual([]);
  });
});

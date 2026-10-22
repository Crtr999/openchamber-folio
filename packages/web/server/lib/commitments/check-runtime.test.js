import { describe, expect, it, vi } from 'vitest';
import { createCommitmentChecks } from './check-runtime.js';
import { DAY } from './cadence.js';
import { parseCommitmentsState } from './store.js';

const NOW = Date.UTC(2026, 9, 22, 15, 0); // 11:00 in New York
const baseItem = (over = {}) => ({
  id: 'abcdef12-item', title: 'Finish paper', dueAt: NOW + 4 * DAY, status: 'active', origin: 'manual', research: true,
  watches: [], finding: '', findingFingerprint: '', snoozedUntil: null, confirmedAt: NOW, createdAt: NOW - 30 * DAY,
  updatedAt: NOW - DAY, doneAt: null, lastCheckedAt: null, lastNudgedAt: null, overdueAskedAt: null, nudgeCount: 0,
  lastDecisionSessionId: null, lastDecisionFingerprint: null, ...over,
});

const fixture = ({ items = [baseItem()], settings = {}, guardOk = true, reply = 'Two sources found. Want an outline?', metadata } = {}) => {
  let state = parseCommitmentsState({ version: 1, settings: { timezone: 'America/New_York', ...settings }, items });
  const store = {
    read: async () => state,
    update: async (change) => { state = parseCommitmentsState(await change(state)); return state; },
  };
  const created = [];
  const prompts = [];
  const client = {
    model: { default: async () => ({ data: { id: 'model-1', providerID: 'prov' } }) },
    session: {
      create: vi.fn(async (input) => { created.push(input); return { id: `session-${created.length}` }; }),
      prompt: vi.fn(async (input) => { prompts.push(input); }),
    },
  };
  const enrollments = new Map();
  const archived = [];
  const checks = createCommitmentChecks({
    store, guard: { check: vi.fn(async () => (guardOk ? { ok: true } : { ok: false, reason: 'zdr-name' })) },
    getClient: () => client, chatsRoot: '/chats', mkdir: vi.fn(async () => {}),
    persistEnrollment: async (id, directory, value) => { enrollments.set(id, value); },
    readSessionMetadata: async (id) => metadata ?? (enrollments.has(id) ? { openchamber: { commitment: enrollments.get(id) } } : {}),
    readLastReply: async () => reply, archiveSession: async (id) => { archived.push(id); },
    now: () => NOW, logger: { warn: () => {}, log: () => {} },
  });
  return { checks, store, client, created, prompts, archived, get state() { return state; } };
};

describe('commitment checks', () => {
  it('starts one check for the nearest due item, claims it first, and gives web-only tools', async () => {
    const f = fixture({ items: [baseItem(), baseItem({ id: 'zzzzzzzz-far', dueAt: NOW + 20 * DAY })] });
    await f.checks.tick();
    expect(f.created).toHaveLength(1);
    expect(f.created[0].title).toBe('Finish paper');
    expect(f.created[0].location.directory).toMatch(/^\/chats\/commitment-checks\/2026-10-22-abcdef12-/);
    expect(f.created[0].permissions).toEqual([
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'websearch', resource: '*', effect: 'allow' },
      { action: 'webfetch', resource: '*', effect: 'allow' },
    ]);
    expect(f.state.items[0].lastCheckedAt).toBe(NOW);
    expect(f.prompts[0].text).toContain('webResearchAllowed');
    await f.checks.tick(); // one at a time
    expect(f.created).toHaveLength(1);
  });

  it('gives a private item no tools at all', async () => {
    const f = fixture({ items: [baseItem({ research: false })] });
    await f.checks.tick();
    expect(f.created[0].permissions).toEqual([{ action: '*', resource: '*', effect: 'deny' }]);
    expect(f.prompts[0].text).toContain('Do not use any tools');
  });

  it('does nothing when off, quiet, out of budget, snoozed, or when the guard says no', async () => {
    for (const f of [
      fixture({ settings: { enabled: false } }),
      fixture({ settings: { quietStart: '10:00', quietEnd: '12:00' } }),
      fixture({ settings: { dailyNudgeLimit: 1 }, items: [baseItem()] }),
      fixture({ items: [baseItem({ status: 'snoozed', snoozedUntil: NOW + DAY })] }),
      fixture({ items: [baseItem({ sourceDirectory: '/Users/c/ZDR Legal' })], guardOk: false }),
    ]) {
      if (f.state.settings.dailyNudgeLimit === 1 && f.state.items[0].status === 'active' && !f.state.settings.quietStart.startsWith('10')) {
        await f.store.update((s) => ({ ...s, delivery: { day: '2026-10-22', count: 1 } }));
      }
      await f.checks.tick();
      expect(f.created).toHaveLength(0);
    }
  });

  it('never checks an item whose source folder is excluded, but still checks manual ones', async () => {
    const blocked = fixture({ items: [baseItem({ sourceDirectory: '/Users/c/ZDR Legal' })], guardOk: false });
    expect(await blocked.checks.checkNow('abcdef12-item')).toEqual({ started: false, reason: 'excluded' });
    expect(blocked.created).toHaveLength(0);
    const manual = fixture();
    expect((await manual.checks.checkNow('abcdef12-item')).started).toBe(true);
  });

  it('delivers a new finding once, counts it against the day, and records it', async () => {
    const f = fixture();
    await f.checks.tick();
    expect(await f.checks.considerCompletion('session-1')).toBe(true);
    expect(f.state.items[0]).toMatchObject({ finding: 'Two sources found. Want an outline?', nudgeCount: 1, lastNudgedAt: NOW });
    expect(f.state.delivery).toEqual({ day: '2026-10-22', count: 1 });
    expect(await f.checks.considerCompletion('session-1')).toBe(false); // repeated event
    expect(f.archived).toEqual([]);
  });

  it('stays quiet and archives a check with nothing new', async () => {
    const f = fixture({ reply: '[CARTER_NO_UPDATE]' });
    await f.checks.tick();
    expect(await f.checks.considerCompletion('session-1')).toBe(false);
    expect(f.state.delivery).toBeNull();
    expect(f.archived).toEqual(['session-1']);
  });

  it('treats a reply typed by the user afterwards as ordinary chat, and a repeated event as a repeat', async () => {
    const metadata = { openchamber: { commitment: { itemId: 'abcdef12-item' } } };
    const decided = baseItem({ lastDecisionSessionId: 'session-1', lastDecisionFingerprint: 'earlier' });
    const joined = fixture({ items: [decided], metadata, reply: 'Sure, here is an outline.' });
    expect(await joined.checks.considerCompletion('session-1')).toBe(true);
    expect(joined.archived).toEqual([]);
    const { fingerprintOf } = await import('./decide.js');
    const repeated = fixture({ items: [{ ...decided, lastDecisionFingerprint: fingerprintOf('Sure, here is an outline.') }], metadata, reply: 'Sure, here is an outline.' });
    expect(await repeated.checks.considerCompletion('session-1')).toBe(false);
    expect(repeated.archived).toEqual([]);
  });

  it('leaves non-check sessions to the caller', async () => {
    const f = fixture({ metadata: {} });
    expect(await f.checks.considerCompletion('ordinary')).toBeUndefined();
  });

  it('ignores a check for an item that is now done', async () => {
    const f = fixture();
    await f.checks.tick();
    await f.store.update((s) => ({ ...s, items: s.items.map((i) => ({ ...i, status: 'done' })) }));
    expect(await f.checks.considerCompletion('session-1')).toBe(false);
  });

  it('recognises its own folder so capture never reads it', () => {
    const f = fixture();
    expect(f.checks.isOwnDirectory('/chats/commitment-checks/2026-10-22-x')).toBe(true);
    expect(f.checks.isOwnDirectory('/chats/2026-10-22-x')).toBe(false);
    expect(f.checks.isOwnDirectory('/chats/commitment-checks-evil')).toBe(false);
  });

  it('reports a failed start without throwing, and still waits a full interval', async () => {
    const f = fixture();
    f.client.session.create.mockRejectedValueOnce(new Error('offline'));
    await f.checks.tick();
    expect(f.state.items[0].lastCheckedAt).toBe(NOW);
    await f.checks.tick();
    expect(f.created).toHaveLength(0);
  });
});

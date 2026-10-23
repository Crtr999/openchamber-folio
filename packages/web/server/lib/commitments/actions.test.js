import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommitmentActions } from './actions.js';
import { createCommitmentsStore } from './store.js';

let directory;
let store;
const allow = { check: vi.fn(async () => ({ ok: true })) };
const make = (guard = allow) => createCommitmentActions({ store, guard, now: () => Date.UTC(2026, 9, 22, 16) });
const run = (actions, action, input = {}) => actions.execute(action, input, '/work/friend', { contextSessionId: 'ses_1' });

beforeEach(async () => {
  directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'commitments-actions-'));
  store = createCommitmentsStore({ fs: fsp, filePath: path.join(directory, 'commitments.json') });
  await store.setSettings({ timezone: 'America/New_York' });
});
afterEach(async () => { await fsp.rm(directory, { recursive: true, force: true }); });

describe('commitment actions', () => {
  it('adds, lists and finds items by words from the title', async () => {
    const actions = make();
    const { commitment } = await run(actions, 'commitment.add', { title: 'Law review paper', due: '2026-10-30' });
    expect(commitment.due).toBe('2026-10-30');
    const [stored] = (await store.read()).items;
    expect(stored).toMatchObject({ origin: 'manual', sourceDirectory: '/work/friend', sourceSessionId: 'ses_1' });
    expect((await run(actions, 'commitment.list')).commitments).toHaveLength(1);
    const done = await run(actions, 'commitment.update', { commitmentId: 'review paper', status: 'done' });
    expect(done.commitment.status).toBe('done');
    expect((await run(actions, 'commitment.list')).commitments).toHaveLength(0);
  });

  it('snoozes for a day by default and removes without deleting the record', async () => {
    const actions = make();
    const { commitment } = await run(actions, 'commitment.add', { title: 'Call the bank', due: '2026-10-25' });
    const snoozed = await run(actions, 'commitment.update', { commitmentId: commitment.id, status: 'snoozed' });
    expect(snoozed.commitment.status).toBe('snoozed');
    expect((await store.read()).items[0].snoozedUntil).toBe(Date.UTC(2026, 9, 23, 16));
    await run(actions, 'commitment.remove', { commitmentId: commitment.id });
    expect((await store.read()).items[0].status).toBe('dismissed');
  });

  it('refuses ambiguous or unknown references and bad input', async () => {
    const actions = make();
    await run(actions, 'commitment.add', { title: 'Draft memo A', due: '2026-10-25' });
    await run(actions, 'commitment.add', { title: 'Draft memo B', due: '2026-10-26' });
    await expect(run(actions, 'commitment.update', { commitmentId: 'draft memo', status: 'done' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(run(actions, 'commitment.update', { commitmentId: 'nothing', status: 'done' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(run(actions, 'commitment.add', { title: 'No date' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(run(actions, 'commitment.add', { title: 'Bad', due: 'tomorrow' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('is unavailable from a folder the guard refuses', async () => {
    const actions = make({ check: async () => ({ ok: false, reason: 'zdr-name' }) });
    await expect(run(actions, 'commitment.list')).rejects.toMatchObject({ statusCode: 403 });
    await expect(run(actions, 'commitment.add', { title: 'x', due: '2026-10-30' })).rejects.toMatchObject({ statusCode: 403 });
    expect((await store.read()).items).toHaveLength(0);
  });
});

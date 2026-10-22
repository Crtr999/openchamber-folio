import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCommitmentsStore } from './store.js';

let directory;
let file;
let time;
const make = () => createCommitmentsStore({ fs: fsp, filePath: file, now: () => time, newId: (() => { let n = 0; return () => `id-${++n}`; })() });

beforeEach(async () => { directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'commitments-')); file = path.join(directory, 'commitments.json'); time = 1_000_000; });
afterEach(async () => { await fsp.rm(directory, { recursive: true, force: true }); });

describe('commitments store', () => {
  it('starts empty without creating a file, then persists additions privately', async () => {
    const store = make();
    expect((await store.read()).items).toEqual([]);
    await expect(fsp.stat(file)).rejects.toThrow();
    const item = await store.add({ title: 'Finish paper', dueAt: 5_000_000, origin: 'manual' });
    expect(item).toMatchObject({ id: 'id-1', status: 'active', research: true, watches: [] });
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o600);
    expect((await make().read()).items).toHaveLength(1);
  });

  it('never overwrites a malformed or newer-version file', async () => {
    await fsp.writeFile(file, '{ not json');
    await expect(make().add({ title: 'x', origin: 'manual', dueAt: 1 })).rejects.toThrow();
    expect(await fsp.readFile(file, 'utf8')).toBe('{ not json');
    await fsp.writeFile(file, JSON.stringify({ version: 2, settings: {}, items: [] }));
    await expect(make().read()).rejects.toThrow();
  });

  it('applies the user\'s edits: done, snooze, confirm, reopen', async () => {
    const store = make();
    const { id } = await store.add({ title: 'Finish paper', dueAt: 5_000_000, origin: 'auto' });
    time = 2_000_000;
    expect(await store.patch(id, { confirmed: true })).toMatchObject({ confirmedAt: 2_000_000 });
    expect(await store.patch(id, { status: 'snoozed', snoozedUntil: 9_000_000 })).toMatchObject({ status: 'snoozed', snoozedUntil: 9_000_000 });
    expect(await store.patch(id, { status: 'done' })).toMatchObject({ status: 'done', doneAt: 2_000_000, snoozedUntil: null });
    expect(await store.patch(id, { status: 'active' })).toMatchObject({ status: 'active', doneAt: null });
    expect(await store.patch('missing', { status: 'done' })).toBeNull();
  });

  it('rejects unknown or agent-only fields on user edits', async () => {
    const store = make();
    const { id } = await store.add({ title: 'Finish paper', dueAt: 5_000_000, origin: 'manual' });
    await expect(store.patch(id, { nudgeCount: 9 })).rejects.toThrow();
    await expect(store.patch(id, { confirmed: false })).rejects.toThrow();
  });

  it('serializes concurrent writes without losing any', async () => {
    const store = make();
    await Promise.all([1, 2, 3, 4, 5].map((n) => store.add({ title: `Item ${n}`, dueAt: n * 1000, origin: 'manual' })));
    expect((await store.read()).items).toHaveLength(5);
  });

  it('removes items and validates settings', async () => {
    const store = make();
    const { id } = await store.add({ title: 'Finish paper', dueAt: 5_000_000, origin: 'manual' });
    expect(await store.remove(id)).toBe(true);
    expect(await store.remove(id)).toBe(false);
    expect(await store.setSettings({ dailyNudgeLimit: 2, timezone: 'America/New_York' })).toMatchObject({ dailyNudgeLimit: 2 });
    await expect(store.setSettings({ dailyNudgeLimit: 99 })).rejects.toThrow();
    await expect(store.setSettings({ timezone: 'Not/AZone' })).rejects.toThrow();
  });
});

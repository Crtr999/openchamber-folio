import { describe, expect, it, vi } from 'vitest';
import { createCompanionDelivery } from './delivery.js';

const createFixture = ({ enrolled = true, previous = 'Earlier idea', reply = 'New idea', fail = false } = {}) => {
  const persistEnrollment = vi.fn(async () => undefined);
  const readLastReply = vi.fn(async (id) => {
    if (fail) throw new Error('offline');
    return id === 'previous' ? previous : reply;
  });
  const delivery = createCompanionDelivery({
    folderGuard: { check: async () => ({ ok: true }) }, canReadProject: async () => true,
    readSessionMetadata: async () => enrolled ? { openchamber: { companion: { taskId: 'companion:12345678', previousSessionId: 'previous' } } } : {},
    persistEnrollment, readLastReply,
  });
  return { delivery, persistEnrollment, readLastReply };
};

describe('companion result delivery', () => {
  it('keeps normal chats and malformed/missing enrollment unchanged', async () => {
    const { delivery, readLastReply, persistEnrollment } = createFixture({ enrolled: false, reply: '[CARTER_NO_UPDATE]' });
    expect(await delivery.shouldNotify('current')).toBe(true);
    expect(readLastReply).not.toHaveBeenCalled();
    expect(await delivery.prepareRun({ sessionID: 'current', directory: '/project', task: { id: 'ordinary' } })).toBe('');
    expect(persistEnrollment).not.toHaveBeenCalled();
  });
  it('suppresses explicit successful no-change and identical complete results', async () => {
    expect(await createFixture({ reply: '[CARTER_NO_UPDATE]' }).delivery.shouldNotify('current')).toBe(false);
    expect(await createFixture({ reply: 'Earlier idea' }).delivery.shouldNotify('current')).toBe(false);
    expect(await createFixture().delivery.shouldNotify('current')).toBe(true);
    expect(await createFixture({ reply: 'Mention [CARTER_NO_UPDATE] but access failed' }).delivery.shouldNotify('current')).toBe(true);
  });
  it('does not turn unreadable, empty or truncated evidence into silence', async () => {
    for (const fixture of [{ fail: true }, { reply: '' }, { previous: '' }, { reply: 'x'.repeat(6001), previous: 'x'.repeat(6001) }]) {
      expect(await createFixture(fixture).delivery.shouldNotify('current')).toBe(true);
    }
  });
  it('persists the predecessor before returning scoped context and survives missing history', async () => {
    const { delivery, persistEnrollment } = createFixture();
    const context = await delivery.prepareRun({ sessionID: 'current', directory: '/project', task: { id: 'companion:12345678', state: { lastSessionId: 'previous' } } });
    expect(persistEnrollment).toHaveBeenCalledWith('current', '/project', { taskId: 'companion:12345678', previousSessionId: 'previous' });
    expect(context).toContain('Earlier idea');
    expect(context).toContain('[CARTER_NO_UPDATE]');
    const noHistory = await createFixture({ fail: true }).delivery.prepareRun({ sessionID: 'current', directory: '/project', task: { id: 'companion:12345678', state: { lastSessionId: 'previous' } } });
    expect(noHistory).toContain('No previous result is available');
  });
  it('refuses dispatch preparation when enrollment cannot be stored', async () => {
    const delivery = createCompanionDelivery({ folderGuard: { check: async () => ({ ok: true }) }, readSessionMetadata: async () => ({}), readLastReply: async () => '', persistEnrollment: async () => { throw new Error('disk unavailable'); } });
    await expect(delivery.prepareRun({ sessionID: 'current', directory: '/project', task: { id: 'companion:12345678' } })).rejects.toThrow('disk unavailable');
  });
  it('never reads an enrolled private result or prepares a private run', async () => {
    const reads = [];
    const delivery = createCompanionDelivery({
      folderGuard: { check: async () => ({ ok: false }) }, canReadProject: async () => false,
      readSessionMetadata: async () => ({ openchamber: { companion: { projectId: 'synthetic-private', taskId: 'companion:12345678' } } }),
      readLastReply: async () => { reads.push('reply'); return 'Synthetic private text'; },
      persistEnrollment: async () => { reads.push('enroll'); },
    });
    expect(await delivery.inspectResult('synthetic')).toEqual({ kind: 'quiet' });
    await expect(delivery.prepareRun({ sessionID: 'synthetic', directory: '/synthetic/ZDR', task: { id: 'companion:12345678' } })).rejects.toThrow();
    expect(reads).toEqual([]);
  });
});

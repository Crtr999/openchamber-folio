import { describe, expect, test } from 'bun:test';
import type { PermissionReply } from '@/types/permission';
import { createPermissionReply } from '@/sync/permission-replies';

describe('explicit permission replies', () => {
  for (const response of ['once', 'always', 'reject'] satisfies PermissionReply[]) {
    test(`forwards ${response} unchanged and settles only after acknowledgement`, async () => {
      const responses: PermissionReply[] = [];
      let acknowledge = () => {};
      const completion = new Promise<void>((resolve) => { acknowledge = resolve; });
      const reply = createPermissionReply(async (value) => {
        responses.push(value);
        await completion;
      });
      const states: string[] = [];
      const unsubscribe = reply.subscribe(() => states.push(reply.getSnapshot()));
      expect(reply.getSnapshot()).toBe('idle');
      expect(responses).toEqual([]);
      const pending = reply.respond(response);
      expect(reply.getSnapshot()).toBe('pending');
      expect(await reply.respond('reject')).toBe(false);
      expect(await reply.respond('always')).toBe(false);
      expect(responses).toEqual([response]);
      acknowledge();
      expect(await pending).toBe(true);
      expect(reply.getSnapshot()).toBe('settled');
      expect(await reply.respond(response)).toBe(false);
      expect(states).toEqual(['pending', 'settled']);
      unsubscribe();
    });
  }

  test('preserves a failed request for an explicit choice, without automatic retry', async () => {
    const responses: PermissionReply[] = [];
    const reply = createPermissionReply(async (response) => {
      responses.push(response);
      if (responses.length === 1) throw new Error('offline');
    });
    expect(await reply.respond('once')).toBe(false);
    expect(reply.getSnapshot()).toBe('failed');
    expect(responses).toEqual(['once']);
    expect(await reply.respond('reject')).toBe(true);
    expect(responses).toEqual(['once', 'reject']);
    expect(reply.getSnapshot()).toBe('settled');
  });

  test('a pending request does not block a different request', async () => {
    let acknowledge = () => {};
    const first = createPermissionReply(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
    const second = createPermissionReply(async () => {});
    const pending = first.respond('once');
    expect(await second.respond('reject')).toBe(true);
    expect(first.getSnapshot()).toBe('pending');
    acknowledge();
    await pending;
  });
});

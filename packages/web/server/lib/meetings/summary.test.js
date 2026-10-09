import { createHash } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { createMeetingSummaryService } from './summary.js';

const models = [
  { providerID: 'test-provider', id: 'test-mini', family: 'gpt-mini', name: 'Test Mini', enabled: true },
  { providerID: 'disabled', id: 'disabled-mini', family: 'gpt-mini', enabled: false },
  { providerID: 'large-only', id: 'large', family: 'large', enabled: true },
];
const meeting = () => ({
  meetingId: 'synthetic-meeting', status: 'stopped', model: 'test-provider/test-mini',
  title: 'PRIVATE_TITLE', notes: 'PRIVATE_NOTES', calendar: 'PRIVATE_CALENDAR', audio: 'PRIVATE_AUDIO',
  segments: [{ source: 'microphone', startMs: 0, endMs: 1000, text: '  Synthetic decision.  ', label: 'PRIVATE_LABEL', createdAt: 'PRIVATE_DATE' }],
});
const fixture = (overrides = {}) => {
  const calls = [];
  const service = createMeetingSummaryService({
    getModels: async () => models,
    generateText: async (input) => { calls.push(input); return { text: 'Synthetic summary', providerID: 'test-provider', modelID: 'test-mini' }; },
    enterpriseMode: () => false, ...overrides,
  });
  return { service, calls };
};
const approvedInput = async (service, input = meeting()) => ({ ...input, approvalToken: (await service.prepare(input)).approvalToken, approved: true });

describe('deliberate meeting summary', () => {
  it('lists only configured callable small-model choices without generating or approving', async () => {
    const { service, calls } = fixture();
    const preview = await service.prepare();
    expect(preview.models).toEqual([{ model: 'test-provider/test-mini', providerID: 'test-provider', modelID: 'test-mini', name: 'Test Mini' }]);
    expect(preview.disclosure).toEqual({ data: 'transcript-only', cost: 'unknown', subscriptionCoverage: 'unknown' });
    expect(preview.approvalToken).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('binds exact canonical transcript fields and sends no private metadata', async () => {
    const { service, calls } = fixture();
    const input = meeting();
    const canonical = input.segments.map(({ source, startMs, endMs, text }) => ({ source, startMs, endMs, text }));
    const expectedRevision = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
    const prepared = await service.prepare(input);
    expect(prepared.transcriptRevision).toBe(expectedRevision);
    expect(calls).toHaveLength(0);
    const result = await service.generate({ ...input, approvalToken: prepared.approvalToken, approved: true });
    expect(result).toEqual({ text: 'Synthetic summary', providerID: 'test-provider', modelID: 'test-mini', transcriptRevision: expectedRevision });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: input.model, onOverflow: 'error', maxOutputTokens: 4000 });
    expect(calls[0].prompt).toContain(JSON.stringify(canonical));
    for (const secret of ['PRIVATE_TITLE', 'PRIVATE_NOTES', 'PRIVATE_CALENDAR', 'PRIVATE_AUDIO', 'PRIVATE_LABEL', 'PRIVATE_DATE']) {
      expect(JSON.stringify(calls)).not.toContain(secret);
    }
  });

  it('refuses missing, false, string or unprepared approval', async () => {
    for (const approved of [undefined, false, 'true', true]) {
      const { service, calls } = fixture();
      await expect(service.generate({ ...meeting(), approved })).rejects.toMatchObject({ code: 'summary_approval_required' });
      expect(calls).toHaveLength(0);
    }
    const { service, calls } = fixture();
    const input = await approvedInput(service);
    await expect(service.generate({ ...input, approved: false })).rejects.toMatchObject({ code: 'summary_approval_required' });
    expect(calls).toHaveLength(0);
  });

  it('rejects changes to model, meeting and every transcript field', async () => {
    const changes = [
      { model: 'other/mini' }, { meetingId: 'other-meeting' },
      ...[{ source: 'system' }, { startMs: 1 }, { endMs: 1001 }, { text: 'changed' }].map((change) => ({ segments: [{ ...meeting().segments[0], ...change }] })),
    ];
    for (const change of changes) {
      const { service, calls } = fixture();
      const input = await approvedInput(service);
      await expect(service.generate({ ...input, ...change })).rejects.toMatchObject({ code: 'summary_approval_required' });
      expect(calls).toHaveLength(0);
    }
  });

  it('allows only closed meetings, including interrupted recordings', async () => {
    for (const status of ['draft', 'recording', 'paused', undefined]) {
      const { service, calls } = fixture();
      await expect(service.prepare({ ...meeting(), status })).rejects.toMatchObject({ code: 'invalid_state' });
      const input = await approvedInput(service);
      await expect(service.generate({ ...input, status })).rejects.toMatchObject({ code: 'invalid_state' });
      expect(calls).toHaveLength(0);
    }
    const { service } = fixture();
    await expect(service.generate(await approvedInput(service, { ...meeting(), status: 'interrupted' }))).resolves.toMatchObject({ text: 'Synthetic summary' });
  });

  it('rejects empty and malformed transcript segments', async () => {
    for (const segments of [[], [{ ...meeting().segments[0], text: ' ' }], [{ ...meeting().segments[0], source: 'speaker' }], [{ ...meeting().segments[0], endMs: -1 }]]) {
      const { service, calls } = fixture();
      await expect(service.prepare({ ...meeting(), segments })).rejects.toMatchObject({ code: 'invalid_transcript' });
      expect(calls).toHaveLength(0);
    }
  });

  it('expires, replaces and disposes approvals', async () => {
    let clock = 1000;
    const { service, calls } = fixture({ now: () => clock });
    const first = await approvedInput(service);
    const second = await approvedInput(service);
    await expect(service.generate(first)).rejects.toMatchObject({ code: 'summary_approval_required' });
    clock += 300_000;
    await expect(service.generate(second)).rejects.toMatchObject({ code: 'summary_approval_required' });
    const third = await approvedInput(service);
    service.dispose();
    await expect(service.generate(third)).rejects.toMatchObject({ code: 'summary_cancelled' });
    expect(calls).toHaveLength(0);
  });

  it('consumes approval before awaiting, so concurrent requests cannot duplicate dispatch', async () => {
    const { service, calls } = fixture();
    const input = await approvedInput(service);
    const results = await Promise.allSettled([service.generate(input), service.generate(input)]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(calls).toHaveLength(1);
    await expect(service.generate(input)).rejects.toMatchObject({ code: 'summary_approval_required' });
  });

  it('cancellation and disposal during catalog lookup prevent transcript dispatch', async () => {
    for (const dispose of [false, true]) {
      let release;
      let reads = 0;
      const catalog = new Promise((resolve) => { release = resolve; });
      const { service, calls } = fixture({ getModels: () => ++reads === 1 ? Promise.resolve(models) : catalog });
      const input = await approvedInput(service);
      const controller = new AbortController();
      const pending = service.generate(input, { signal: controller.signal }).catch((error) => error);
      if (dispose) service.dispose();
      else controller.abort();
      release(models);
      expect(await pending).toMatchObject({ code: 'summary_cancelled' });
      expect(calls).toHaveLength(0);
    }
  });

  it('native authorization is rechecked after catalog lookup before dispatch', async () => {
    let authorized = true;
    let reads = 0;
    const { service, calls } = fixture({ getModels: async () => { if (++reads === 2) authorized = false; return models; } });
    const input = await approvedInput(service);
    const authorize = () => { if (!authorized) throw Object.assign(new Error('Synthetic denied frame'), { code: 'meeting_forbidden' }); };
    await expect(service.generate(input, { authorize })).rejects.toMatchObject({ code: 'meeting_forbidden' });
    expect(calls).toHaveLength(0);
  });

  it('disposal during preparation cannot recreate an approval', async () => {
    let release;
    const catalog = new Promise((resolve) => { release = resolve; });
    const { service, calls } = fixture({ getModels: () => catalog });
    const pending = service.prepare(meeting()).catch((error) => error);
    service.dispose(); release(models);
    expect(await pending).toMatchObject({ code: 'summary_cancelled' });
    await expect(service.prepare()).rejects.toMatchObject({ code: 'summary_cancelled' });
    expect(calls).toHaveLength(0);
  });

  it('disposal aborts dispatched generation and rejects even a late synthetic result', async () => {
    let release;
    let reached;
    let signal;
    const generation = new Promise((resolve) => { release = resolve; });
    const dispatched = new Promise((resolve) => { reached = resolve; });
    const { service } = fixture({ generateText: (request) => { signal = request.signal; reached(); return generation; } });
    const input = await approvedInput(service);
    const pending = service.generate(input).catch((error) => error);
    await dispatched;
    service.dispose();
    expect(signal.aborted).toBe(true);
    release({ text: 'Synthetic late result', providerID: 'test-provider', modelID: 'test-mini' });
    expect(await pending).toMatchObject({ code: 'summary_cancelled' });
  });

  it('refuses unknown or disabled models without fallback and rechecks availability', async () => {
    let catalog = models;
    const { service, calls } = fixture({ getModels: async () => catalog });
    for (const model of ['disabled/disabled-mini', 'unknown/mini', '', null]) {
      await expect(service.prepare({ ...meeting(), model })).rejects.toMatchObject({ code: 'summary_unavailable' });
    }
    const input = await approvedInput(service);
    catalog = [];
    await expect(service.generate(input)).rejects.toMatchObject({ code: 'summary_unavailable' });
    expect(calls).toHaveLength(0);
    expect(await service.prepare()).toMatchObject({ available: false, reasonCode: 'no_models' });
  });

  it('does not treat a failed catalog read as an empty successful choice list', async () => {
    const { service, calls } = fixture({ getModels: async () => { throw new Error('synthetic catalog failure'); } });
    await expect(service.prepare()).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('checks enterprise policy on preparation and immediately before dispatch', async () => {
    let blocked = true;
    let reads = 0;
    const { service, calls } = fixture({ enterpriseMode: () => blocked, getModels: async () => { reads++; return models; } });
    await expect(service.prepare()).rejects.toMatchObject({ code: 'enterprise_mode', statusCode: 403 });
    expect(reads).toBe(0);
    blocked = false;
    const input = await approvedInput(service);
    blocked = true;
    await expect(service.generate(input)).rejects.toMatchObject({ code: 'enterprise_mode' });
    expect(calls).toHaveLength(0);
    const late = fixture({ enterpriseMode: () => blocked, getModels: async () => { blocked = true; return models; } });
    blocked = false;
    await expect(late.service.prepare(meeting())).rejects.toMatchObject({ code: 'enterprise_mode' });
  });

  it('sanitizes provider failures, consumes approval and never retries or falls back', async () => {
    let count = 0;
    const { service } = fixture({ generateText: async () => { count++; throw new Error('PRIVATE_TRANSCRIPT upstream'); } });
    const input = await approvedInput(service);
    await expect(service.generate(input)).rejects.toMatchObject({ code: 'summary_failed' });
    await expect(service.generate(input)).rejects.toMatchObject({ code: 'summary_approval_required' });
    expect(count).toBe(1);
  });

  it('rechecks enterprise policy after the generation catalog lookup', async () => {
    let blocked = false;
    let reads = 0;
    const { service, calls } = fixture({
      enterpriseMode: () => blocked,
      getModels: async () => { if (++reads === 2) blocked = true; return models; },
    });
    const input = await approvedInput(service);
    await expect(service.generate(input)).rejects.toMatchObject({ code: 'enterprise_mode' });
    expect(calls).toHaveLength(0);
  });

  it('policy changes during dispatch reject the result rather than returning it for storage', async () => {
    let blocked = false;
    const { service } = fixture({
      enterpriseMode: () => blocked,
      generateText: async () => { blocked = true; return { text: 'Synthetic result', providerID: 'test-provider', modelID: 'test-mini' }; },
    });
    const input = await approvedInput(service);
    await expect(service.generate(input)).rejects.toMatchObject({ code: 'enterprise_mode' });
  });

  it('refuses empty, mismatched and truncated generation results', async () => {
    for (const result of [
      { text: '', providerID: 'test-provider', modelID: 'test-mini' },
      { text: 'Summary', providerID: 'other', modelID: 'test-mini' },
      { text: 'Summary', providerID: 'test-provider', modelID: 'test-mini', inputTruncated: true },
    ]) {
      const { service } = fixture({ generateText: async () => result });
      await expect(service.generate(await approvedInput(service))).rejects.toMatchObject({ code: 'summary_failed' });
    }
  });
});

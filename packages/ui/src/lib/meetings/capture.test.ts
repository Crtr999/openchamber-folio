import { expect, test } from 'bun:test';
import { PCMBuffer, CHUNK_SAMPLES, acquireMeetingStream, withMeetingDeadline } from './capture';
import { meetingSchema } from './contract';

test('PCM buffers emit exactly bounded 10s chunks and clear input, remainder and reset data', () => {
    const chunks: Float32Array[] = [];
    const buffer = new PCMBuffer((pcm) => chunks.push(pcm));
    const input = new Float32Array(CHUNK_SAMPLES + 1600).fill(0.25);
    buffer.append(input);
    expect(input.every((value) => value === 0)).toBe(true);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].length).toBe(CHUNK_SAMPLES);
    expect(chunks[0][0]).toBe(0.25);
    buffer.flush();
    expect(chunks[1].length).toBe(1600);
    buffer.append(new Float32Array(1600).fill(0.5));
    buffer.clear(); buffer.flush();
    expect(chunks).toHaveLength(2);
    buffer.append(new Float32Array(1).fill(0.75)); buffer.flush();
    expect(chunks[2]).toEqual(new Float32Array([0.75]));
    chunks.forEach((chunk) => chunk.fill(0));
});

test('permission timeout stops a stream resolving after its deadline', async () => {
    let resolve: (stream: { getTracks: () => { stop: () => void }[] }) => void = () => {};
    const operation = new Promise<{ getTracks: () => { stop: () => void }[] }>((done) => { resolve = done; });
    let stopped = 0;
    await expect(acquireMeetingStream(operation, () => true, 1)).rejects.toThrow('meeting_timeout');
    resolve({ getTracks: () => [{ stop: () => { stopped++; } }] });
    await Promise.resolve(); await Promise.resolve();
    expect(stopped).toBe(1);
});

test('generation invalidation stops permission result before ownership; denial stays failure', async () => {
    let stopped = 0;
    const stream = { getTracks: () => [{ stop: () => { stopped++; } }] };
    await expect(acquireMeetingStream(Promise.resolve(stream), () => false)).rejects.toThrow('meeting_permission_expired');
    expect(stopped).toBe(1);
    await expect(acquireMeetingStream(Promise.reject(new Error('denied')), () => true)).rejects.toThrow('denied');
    expect(await acquireMeetingStream(Promise.resolve(stream), () => true)).toBe(stream);
    expect(stopped).toBe(1);
});

test('bounded operation deadline propagates success and failure, never empty success', async () => {
    expect(await withMeetingDeadline(Promise.resolve(3))).toBe(3);
    await expect(withMeetingDeadline(Promise.reject(new Error('failed')))).rejects.toThrow('failed');
    await expect(withMeetingDeadline(new Promise(() => {}), 1)).rejects.toThrow('meeting_timeout');
});

test('canonical Meeting parses source timestamps and persisted sanctioned summary without invented speakers', () => {
    const date = '2026-10-08T12:00:00.000Z';
    const result = meetingSchema.parse({ version: 1, id: '5e2bc054-8802-4c4d-93cc-6b621beedfb6', title: 'Synthetic fixture', createdAt: date, updatedAt: date, status: 'stopped', interruptionReason: null, notes: '', segments: [{ source: 'system', label: 'System audio', startMs: 0, endMs: 1000, text: 'Synthetic text', createdAt: date }], summary: { status: 'available', text: 'Synthetic summary', providerID: 'fixture', modelID: 'fixture', transcriptRevision: 'revision', createdAt: date } });
    expect(result.segments[0].source).toBe('system');
    expect(result.summary.status).toBe('available');
    expect('speaker' in result.segments[0]).toBe(false);
    expect(meetingSchema.safeParse({ ...result, status: 'unknown' }).success).toBe(false);
});

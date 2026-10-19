import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { meetingCapture, CHUNK_SAMPLES, MAX_PENDING_CHUNKS } from './capture';
import { listMeetings, listSummaryModels, prepareMeetingSummary, generateMeetingSummary, type Meeting } from './contract';

class SyntheticTrack extends EventTarget {
    stopped = false;
    stop() { this.stopped = true; }
}
class SyntheticStream {
    constructor(readonly tracks = [new SyntheticTrack()]) {}
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks; }
}
class SyntheticWorklet {
    static latest: SyntheticWorklet | null = null;
    constructor() { SyntheticWorklet.latest = this; }
    port: SyntheticPort = {
        onmessage: null,
        postMessage: (message: string) => { if (message === 'flush') queueMicrotask(() => this.port.onmessage?.({ data: { flushed: true } })); },
    };
    connect() {}
    disconnect() {}
}
type SyntheticPort = { onmessage: ((event: { data: Float32Array | { flushed: true } }) => void) | null; postMessage: (message: string) => void };
class SyntheticAudioContext {
    static resumeOperation = async () => {};
    destination = {};
    audioWorklet = { addModule: async () => {} };
    async suspend() {}
    async resume() { await SyntheticAudioContext.resumeOperation(); }
    async close() {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
}
let browser: Window;
let descriptors: Map<string, PropertyDescriptor | undefined>;
let record: Meeting;
let available = true;
let calls: string[];
let stream: SyntheticStream;
let lifecycle: (event: { payload: { id: string; reason: string } }) => void;
const globals = ['window', 'navigator', 'AudioContext', 'AudioWorkletNode', 'MediaStream'];

beforeEach(() => {
    browser = new Window({ url: 'http://localhost:3000' });
    descriptors = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    calls = []; available = true; stream = new SyntheticStream(); lifecycle = () => {};
    SyntheticAudioContext.resumeOperation = async () => {};
    const date = '2026-10-08T12:00:00.000Z';
    record = { version: 1, id: '5e2bc054-8802-4c4d-93cc-6b621beedfb6', title: 'Synthetic fixture', createdAt: date, updatedAt: date, status: 'draft', interruptionReason: null, notes: '', segments: [], summary: { status: 'unavailable', reason: 'Not configured' } };
    Object.assign(browser, {
        __OPENCHAMBER_ELECTRON__: { runtime: 'electron' }, __OPENCHAMBER_LOCAL_ORIGIN__: 'http://localhost:3000', __OPENCHAMBER_API_BASE_URL__: 'http://localhost:3000',
        __OPENCHAMBER_DESKTOP__: {
            listen: async (event: string, handler: typeof lifecycle) => { expect(event).toBe('desktop:meeting-lifecycle'); lifecycle = handler; return () => { lifecycle = () => {}; }; },
            invoke: async (command: string) => {
                calls.push(command);
                if (command === 'desktop_meeting_readiness') return { available, modelId: 'synthetic' };
                if (command === 'desktop_meeting_list') return { meetings: [record], readiness: { available, modelId: 'synthetic' }, capture: { systemAudioSupported: true, systemAudioValidation: 'pending' }, warnings: [{ id: record.id, code: 'invalid_record', message: 'Safe warning' }] };
                if (command === 'desktop_meeting_interrupt') { record = { ...record, status: 'interrupted', interruptionReason: 'capture-error' }; return record; }
                const status = command === 'desktop_meeting_start' || command === 'desktop_meeting_resume' ? 'recording' : command === 'desktop_meeting_pause' ? 'paused' : 'stopped';
                record = { ...record, status };
                if (command === 'desktop_meeting_start') return { ...record, capture: { mode: 'microphone', degraded: true, systemAudioSupported: true, systemAudioValidation: 'pending' } };
                return record;
            },
        },
    });
    const devices = Object.assign(new EventTarget(), { getUserMedia: async () => stream, getDisplayMedia: async () => { throw new Error('denied'); } });
    Object.assign(globalThis, { window: browser, navigator: { mediaDevices: devices }, AudioContext: SyntheticAudioContext, AudioWorkletNode: SyntheticWorklet, MediaStream: SyntheticStream });
});
afterEach(async () => {
    await meetingCapture.stop();
    browser.close();
    for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
});

test('model readiness refuses before native start or any synthetic permission acquisition', async () => {
    available = false;
    await meetingCapture.start(record, 'microphone');
    expect(meetingCapture.getSnapshot().phase).toBe('error');
    expect(calls).toEqual(['desktop_meeting_readiness', 'desktop_meeting_interrupt']);
    expect(stream.getTracks()[0].stopped).toBe(false);
});
test('single owner survives subscriber navigation and explicitly pauses, resumes and stops', async () => {
    const unsubscribe = meetingCapture.subscribe(() => {});
    await meetingCapture.start(record, 'microphone');
    expect(meetingCapture.getSnapshot().phase).toBe('recording');
    unsubscribe();
    expect(stream.getTracks()[0].stopped).toBe(false);
    await expect(meetingCapture.start(record, 'microphone')).rejects.toThrow('meeting_busy');
    await meetingCapture.pause();
    expect(meetingCapture.getSnapshot().phase).toBe('paused');
    await meetingCapture.resume();
    expect(meetingCapture.getSnapshot().phase).toBe('recording');
    await meetingCapture.stop();
    expect(meetingCapture.getSnapshot().phase).toBe('idle');
    expect(stream.getTracks()[0].stopped).toBe(true);
    expect(calls.filter((command) => command === 'desktop_meeting_stop')).toHaveLength(1);
});
test('native sleep notification clears capture synchronously without sending PCM', async () => {
    await meetingCapture.start(record, 'microphone');
    lifecycle({ payload: { id: record.id, reason: 'sleep' } });
    expect(meetingCapture.getSnapshot().phase).toBe('error');
    expect(meetingCapture.getSnapshot().error).toBe('interrupted');
    expect(stream.getTracks()[0].stopped).toBe(true);
    expect(calls.includes('desktop_meeting_chunk')).toBe(false);
});
test('interruption during audio-context startup cannot restore recording after devices close', async () => {
    let resume: () => void = () => {};
    let reached: () => void = () => {};
    const pending = new Promise<void>((resolve) => { resume = resolve; });
    const resuming = new Promise<void>((resolve) => { reached = resolve; });
    SyntheticAudioContext.resumeOperation = () => { reached(); return pending; };
    const start = meetingCapture.start(record, 'microphone');
    await resuming;
    lifecycle({ payload: { id: record.id, reason: 'sleep' } });
    expect(stream.getTracks()[0].stopped).toBe(true);
    resume();
    await start;
    expect(meetingCapture.getSnapshot().phase).toBe('error');
    expect(calls.includes('desktop_meeting_chunk')).toBe(false);
});

test('backpressure interrupts once and clears in-flight and unsent synthetic chunks', async () => {
    await meetingCapture.start(record, 'microphone');
    let uploaded: number[] | undefined;
    let rejectChunk: (error: Error) => void = () => {};
    let reached: () => void = () => {};
    const pending = new Promise<Meeting>((_resolve, reject) => { rejectChunk = reject; });
    const chunkStarted = new Promise<void>((resolve) => { reached = resolve; });
    Object.assign(browser, { __OPENCHAMBER_DESKTOP__: { invoke: async (command: string, args: { pcm?: number[] }) => {
        calls.push(command);
        if (command === 'desktop_meeting_chunk') { uploaded = args.pcm; reached(); return pending; }
        if (command === 'desktop_meeting_interrupt') {
            record = { ...record, status: 'interrupted', interruptionReason: 'capture-error' };
            rejectChunk(new Error('cancelled'));
        }
        return record;
    } } });
    const send = SyntheticWorklet.latest?.port.onmessage;
    send?.({ data: new Float32Array(CHUNK_SAMPLES).fill(0.25) });
    await chunkStarted;
    for (let index = 0; index < MAX_PENDING_CHUNKS; index++) {
        const pcm = new Float32Array(CHUNK_SAMPLES).fill(0.25);
        send?.({ data: pcm });
        expect(pcm.every((sample) => sample === 0)).toBe(true);
    }
    await Promise.resolve(); await Promise.resolve();
    expect(meetingCapture.getSnapshot().phase).toBe('error');
    expect(stream.getTracks()[0].stopped).toBe(true);
    expect(uploaded?.length).toBe(0);
    expect(calls.filter((command) => command === 'desktop_meeting_chunk')).toHaveLength(1);
    expect(calls.filter((command) => command === 'desktop_meeting_interrupt')).toHaveLength(1);
});

test('normal Stop flushes the tail and releases devices before awaiting transcription', async () => {
    await meetingCapture.start(record, 'microphone');
    let release: (meeting: Meeting) => void = () => {};
    let reached: () => void = () => {};
    let released: () => void = () => {};
    let uploaded: number[] | undefined;
    const chunk = new Promise<Meeting>((resolve) => { release = resolve; });
    const chunkStarted = new Promise<void>((resolve) => { reached = resolve; });
    const devicesReleased = new Promise<void>((resolve) => { released = resolve; });
    stream.getTracks()[0].stop = () => { stream.getTracks()[0].stopped = true; released(); };
    Object.assign(browser, { __OPENCHAMBER_DESKTOP__: { invoke: async (command: string, args: { pcm?: number[] }) => {
        calls.push(command);
        if (command === 'desktop_meeting_chunk') { uploaded = args.pcm; reached(); return chunk; }
        record = { ...record, status: 'stopped' };
        return record;
    } } });
    SyntheticWorklet.latest?.port.onmessage?.({ data: new Float32Array(1600).fill(0.25) });
    const stop = meetingCapture.stop();
    await chunkStarted; await devicesReleased;
    expect(uploaded?.length).toBe(1600);
    expect(calls.includes('desktop_meeting_stop')).toBe(false);
    expect(meetingCapture.getSnapshot().phase).toBe('stopping');
    release(record);
    await stop;
    expect(uploaded?.length).toBe(0);
    expect(meetingCapture.getSnapshot().phase).toBe('idle');
    expect(calls.filter((command) => command === 'desktop_meeting_stop')).toHaveLength(1);
});
test('denied system permission fails explicitly and does not fall back to microphone', async () => {
    await meetingCapture.start(record, 'system-and-microphone');
    expect(meetingCapture.getSnapshot().phase).toBe('error');
    expect(meetingCapture.getSnapshot().error).toBe('system');
    expect(stream.getTracks()[0].stopped).toBe(false);
    expect(calls.includes('desktop_meeting_interrupt')).toBe(true);
});
test('list preserves healthy records and partial warnings; malformed native result is failure', async () => {
    const result = await listMeetings();
    expect(result.meetings).toHaveLength(1);
    expect(result.warnings[0].code).toBe('invalid_record');
    Object.assign(browser, { __OPENCHAMBER_DESKTOP__: { invoke: async () => ({ meetings: [] }) } });
    await expect(listMeetings()).rejects.toThrow();
});

test('Stop during starting cancels ownership and closes a late permission stream', async () => {
    let release: (value: SyntheticStream) => void = () => {};
    let reached: () => void = () => {};
    const pending = new Promise<SyntheticStream>((resolve) => { release = resolve; });
    const permissionStarted = new Promise<void>((resolve) => { reached = resolve; });
    Object.assign(navigator.mediaDevices, { getUserMedia: () => { reached(); return pending; } });
    const start = meetingCapture.start(record, 'microphone');
    await permissionStarted;
    await meetingCapture.stop();
    expect(meetingCapture.getSnapshot().phase).toBe('stopping');
    release(stream);
    await start;
    expect(stream.getTracks()[0].stopped).toBe(true);
    expect(meetingCapture.getSnapshot().phase).toBe('error');
});

test('runtime switch clears synthetic devices immediately and ignores obsolete capture ownership', async () => {
    await meetingCapture.start(record, 'microphone');
    browser.dispatchEvent(new browser.CustomEvent('openchamber:runtime-endpoint-changed'));
    expect(stream.getTracks()[0].stopped).toBe(true);
    expect(meetingCapture.getSnapshot().error).toBe('interrupted');
    expect(calls.includes('desktop_meeting_chunk')).toBe(false);
});

test('a failed start deadline revokes native generation even without a start response', async () => {
    Object.assign(browser, { __OPENCHAMBER_DESKTOP__: {
        listen: async () => () => {},
        invoke: async (command: string) => {
            calls.push(command);
            if (command === 'desktop_meeting_readiness') return { available: true, modelId: 'synthetic' };
            if (command === 'desktop_meeting_start') throw new Error('meeting_timeout');
            if (command === 'desktop_meeting_stop') throw new Error('meeting_busy');
            record = { ...record, status: 'interrupted', interruptionReason: 'capture-error' };
            return record;
        },
    } });
    await meetingCapture.start(record, 'microphone');
    expect(calls).toEqual(['desktop_meeting_readiness', 'desktop_meeting_start', 'desktop_meeting_interrupt']);
    expect(meetingCapture.getSnapshot().meeting?.status).toBe('interrupted');
    expect(meetingCapture.getSnapshot().phase).toBe('error');
});

type SyntheticChunkArgs = { pcm?: number[] };
test('capture failure interrupts a busy native chunk before joining its drain and clears uploaded PCM', async () => {
    await meetingCapture.start(record, 'microphone');
    let uploaded: number[] | undefined;
    let rejectChunk: (error: Error) => void = () => {};
    let reached: () => void = () => {};
    let interrupted: () => void = () => {};
    const chunk = new Promise<Meeting>((resolve, reject) => { void resolve; rejectChunk = reject; });
    const chunkStarted = new Promise<void>((resolve) => { reached = resolve; });
    const nativeInterrupted = new Promise<void>((resolve) => { interrupted = resolve; });
    Object.assign(browser, { __OPENCHAMBER_DESKTOP__: { invoke: async (command: string, args: SyntheticChunkArgs) => {
        calls.push(command);
        if (command === 'desktop_meeting_chunk') { uploaded = args.pcm; reached(); return chunk; }
        if (command === 'desktop_meeting_stop') throw new Error('meeting_busy');
        if (command === 'desktop_meeting_interrupt') {
            record = { ...record, status: 'interrupted', interruptionReason: 'capture-error' };
            rejectChunk(new Error('cancelled'));
            interrupted();
        }
        return record;
    } } });
    SyntheticWorklet.latest?.port.onmessage?.({ data: new Float32Array(CHUNK_SAMPLES).fill(0.25) });
    await chunkStarted;
    expect(uploaded?.length).toBe(CHUNK_SAMPLES);
    let unsubscribe = () => {};
    const settled = new Promise<void>((resolve) => {
        unsubscribe = meetingCapture.subscribe(() => { if (meetingCapture.getSnapshot().meeting?.status === 'interrupted') resolve(); });
    });
    stream.getTracks()[0].dispatchEvent(new Event('ended'));
    await nativeInterrupted;
    await settled; unsubscribe();
    expect(uploaded?.length).toBe(0);
    expect(stream.getTracks()[0].stopped).toBe(true);
    expect(meetingCapture.getSnapshot().phase).toBe('error');
    expect(meetingCapture.getSnapshot().detail).toBe('audio_track_ended');
    expect(calls.includes('desktop_meeting_stop')).toBe(false);
});

test('resuming a closed meeting continues the timeline after its saved text', async () => {
    record = { ...record, status: 'interrupted', interruptionReason: 'quit', segments: [{ source: 'microphone', label: 'Microphone', startMs: 0, endMs: 60000, text: 'Earlier', createdAt: record.createdAt }] };
    await meetingCapture.start(record, 'microphone');
    expect(meetingCapture.getSnapshot().phase).toBe('recording');
    const starts: number[] = [];
    Object.assign(browser, { __OPENCHAMBER_DESKTOP__: { invoke: async (command: string, args: { startMs?: number }) => {
        calls.push(command);
        if (command === 'desktop_meeting_chunk') starts.push(args.startMs ?? -1);
        return record;
    } } });
    SyntheticWorklet.latest?.port.onmessage?.({ data: new Float32Array(CHUNK_SAMPLES).fill(0.25) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(starts).toEqual([60000]);
});

test('a failed phrase is skipped and recording continues; repeated failures stop it visibly', async () => {
    await meetingCapture.start(record, 'microphone');
    let failing = true;
    Object.assign(browser, { __OPENCHAMBER_DESKTOP__: { invoke: async (command: string) => {
        calls.push(command);
        if (command === 'desktop_meeting_chunk' && failing) throw new Error('transcription_failed: Local transcription failed.');
        return record;
    } } });
    const send = () => { SyntheticWorklet.latest?.port.onmessage?.({ data: new Float32Array(CHUNK_SAMPLES).fill(0.25) }); return new Promise((resolve) => setTimeout(resolve, 10)); };
    await send();
    expect(meetingCapture.getSnapshot().phase).toBe('recording');
    expect(meetingCapture.getSnapshot().skipped).toBe(1);
    failing = false;
    await send();
    expect(meetingCapture.getSnapshot().phase).toBe('recording');
    failing = true;
    await send(); await send();
    expect(meetingCapture.getSnapshot().phase).toBe('recording');
    await send();
    expect(meetingCapture.getSnapshot().phase).toBe('error');
    expect(meetingCapture.getSnapshot().detail).toContain('transcription_failed');
});

test('a device list change (headphones connecting) does not end a healthy recording', async () => {
    await meetingCapture.start(record, 'microphone');
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
    await Promise.resolve(); await Promise.resolve();
    expect(meetingCapture.getSnapshot().phase).toBe('recording');
    expect(stream.getTracks()[0].stopped).toBe(false);
    expect(calls.includes('desktop_meeting_interrupt')).toBe(false);
});

test('chunks are cut at a pause once a phrase is long enough, and silence is never uploaded', async () => {
    await meetingCapture.start(record, 'microphone');
    const sent: number[] = [];
    Object.assign(browser, { __OPENCHAMBER_DESKTOP__: { invoke: async (command: string, args: { pcm?: number[] }) => {
        calls.push(command);
        if (command === 'desktop_meeting_chunk') sent.push(args.pcm?.length ?? 0);
        return record;
    } } });
    const send = SyntheticWorklet.latest?.port.onmessage;
    const block = (level: number) => new Float32Array(1600).fill(level);
    // 3.2 s of speech then 0.6 s of quiet: exactly one phrase, cut at the pause.
    for (let index = 0; index < 32; index++) send?.({ data: block(0.2) });
    for (let index = 0; index < 6; index++) send?.({ data: block(0.0005) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(32 * 1600 + 5 * 1600);
    // Pure silence for 12 s produces no upload at all.
    for (let index = 0; index < 120; index++) send?.({ data: block(0) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toHaveLength(1);
});

test('capture errors carry a short diagnostic reason', async () => {
    await meetingCapture.start(record, 'system-and-microphone');
    expect(meetingCapture.getSnapshot().error).toBe('system');
    expect(meetingCapture.getSnapshot().detail).toBe('denied');
});

type SummaryRequest = { id: string; model?: string; approvalToken?: string; approved?: boolean };
test('summary IPC discovers without upload, then sends only authoritative native approval identifiers', async () => {
    const requests: { command: string; args: SummaryRequest }[] = [];
    const choice = { model: 'synthetic/small', providerID: 'synthetic', modelID: 'small', name: 'Small fixture' };
    const disclosure = { data: 'transcript-only', cost: 'unknown', subscriptionCoverage: 'unknown' };
    const prepared = { available: true, models: [choice], disclosure, ...choice, approvalToken: 'fixture-token', transcriptRevision: 'fixture-revision', expiresAt: Date.now() + 1000 };
    record = { ...record, status: 'stopped' };
    Object.assign(browser, { __OPENCHAMBER_DESKTOP__: { invoke: async (command: string, args: SummaryRequest) => {
        requests.push({ command, args });
        if (command === 'desktop_meeting_prepare_summary') return args.model ? prepared : { available: true, models: [choice], disclosure };
        return record;
    } } });
    const choices = await listSummaryModels(record.id);
    expect(choices.models[0].model).toBe(choice.model);
    expect(requests[0]).toEqual({ command: 'desktop_meeting_prepare_summary', args: { id: record.id } });
    const approval = await prepareMeetingSummary(record.id, choice.model);
    expect(requests[1].args).toEqual({ id: record.id, model: choice.model });
    await generateMeetingSummary(record.id, approval);
    expect(requests[2]).toEqual({ command: 'desktop_meeting_generate_summary', args: { id: record.id, model: choice.model, approvalToken: 'fixture-token', approved: true } });
    expect(requests).toHaveLength(3);
});

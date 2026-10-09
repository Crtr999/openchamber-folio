import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createMeetingTranscriber, transcribeLocalChunk } from './local-transcriber.js';

function syntheticClient({ hang = false } = {}) {
  const process = new EventEmitter();
  process.exitCode = null;
  process.signalCode = null;
  process.kill = () => {};
  let emitter;
  let rejectCommit;
  const client = {
    worker: process,
    async createSession(config, events) {
      emitter = events;
      return { sessionId: 'test', requiredSampleRate: 16000 };
    },
    async sendRequest(request) {
      if (request.type !== 'session.commit') return;
      if (hang) return new Promise((resolve, reject) => { rejectCommit = reject; });
      emitter.emit('transcript', { transcript: 'Synthetic local result' });
    },
    shutdown() {
      this.worker = null;
      rejectCommit?.(new Error('Synthetic shutdown'));
    },
  };
  const finish = () => {
    process.exitCode = 0;
    process.emit('close');
  };
  return { client, finish };
}

describe('meeting worker lifetime', () => {
  it('keeps successful PCM ownership until worker closure, then zeros it', async () => {
    const fixture = syntheticClient();
    const audio = Buffer.alloc(32, 1);
    let complete = false;
    const result = transcribeLocalChunk({ audio, modelsDir: '/synthetic', modelId: 'synthetic', signal: new AbortController().signal, workerFactory: () => fixture.client });
    void result.then(() => { complete = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(complete).toBe(false);
    fixture.finish();
    expect(await result).toBe('Synthetic local result');
    expect(audio.every((sample) => sample === 0)).toBe(true);
  });

  it('also joins the worker that abort already removed from the client', async () => {
    const fixture = syntheticClient({ hang: true });
    const controller = new AbortController();
    const audio = Buffer.alloc(32, 1);
    let complete = false;
    const result = transcribeLocalChunk({ audio, modelsDir: '/synthetic', modelId: 'synthetic', signal: controller.signal, workerFactory: () => fixture.client });
    void result.catch(() => { complete = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(complete).toBe(false);
    fixture.finish();
    await expect(result).rejects.toThrow();
    expect(audio.every((sample) => sample === 0)).toBe(true);
  });

  it('abort between setup and append cannot restart the worker or send audio', async () => {
    const fixture = syntheticClient();
    const controller = new AbortController();
    let requests = 0;
    fixture.client.createSession = async () => {
      controller.abort();
      return { sessionId: 'test', requiredSampleRate: 16000 };
    };
    fixture.client.sendRequest = async () => { requests++; };
    const audio = Buffer.alloc(32, 1);
    const result = transcribeLocalChunk({ audio, modelsDir: '/synthetic', modelId: 'synthetic', signal: controller.signal, workerFactory: () => fixture.client }).catch((error) => error);
    await Promise.resolve(); await Promise.resolve();
    fixture.finish();
    expect(await result).toMatchObject({ code: 'interrupted' });
    expect(requests).toBe(0);
    expect(audio.every((sample) => sample === 0)).toBe(true);
  });
});

describe('warm meeting transcriber', () => {
  function factory({ failOn = [] } = {}) {
    const clients = [];
    let total = 0;
    const make = () => {
      const process = new EventEmitter();
      process.exitCode = null; process.signalCode = null; process.kill = () => {};
      let emitter;
      const client = {
        worker: process, commits: 0, appended: [],
        async createSession(config, events) { emitter = events; return { sessionId: 'warm', requiredSampleRate: 16000 }; },
        async sendRequest(request) {
          if (request.type === 'session.append') client.appended.push(request.audio);
          if (request.type !== 'session.commit') return;
          client.commits += 1; total += 1;
          if (failOn.includes(total)) throw new Error('Synthetic decode failure');
          emitter.emit('transcript', { transcript: `chunk ${client.commits}` });
        },
        shutdown() { client.worker = null; process.exitCode = 0; queueMicrotask(() => process.emit('close')); },
      };
      clients.push(client);
      return client;
    };
    return { make, clients };
  }

  it('reuses one worker across chunks and kills it on release', async () => {
    const fixture = factory();
    const transcriber = createMeetingTranscriber({ modelsDir: '/synthetic', modelId: 'synthetic', workerFactory: fixture.make });
    await transcriber.warm();
    const signal = new AbortController().signal;
    expect(await transcriber.transcribe(Buffer.alloc(32, 1), signal)).toBe('chunk 1');
    expect(await transcriber.transcribe(Buffer.alloc(32, 1), signal)).toBe('chunk 2');
    expect(fixture.clients).toHaveLength(1);
    expect(fixture.clients[0].worker).not.toBeNull();
    await transcriber.release();
    expect(fixture.clients[0].worker).toBeNull();
    // A release only ends the worker; the next recording starts a fresh one.
    expect(await transcriber.transcribe(Buffer.alloc(32, 1), signal)).toBe('chunk 1');
    expect(fixture.clients).toHaveLength(2);
    await transcriber.release();
  });

  it('never reuses a worker after a failed decode', async () => {
    const fixture = factory({ failOn: [1] });
    const transcriber = createMeetingTranscriber({ modelsDir: '/synthetic', modelId: 'synthetic', workerFactory: fixture.make });
    const signal = new AbortController().signal;
    await expect(transcriber.transcribe(Buffer.alloc(32, 1), signal)).rejects.toThrow();
    expect(fixture.clients[0].worker).toBeNull();
    expect(await transcriber.transcribe(Buffer.alloc(32, 1), signal)).toBe('chunk 1');
    expect(fixture.clients).toHaveLength(2);
    await transcriber.release();
  });

  it('abort kills the warm worker and the next chunk starts a fresh one', async () => {
    const fixture = factory();
    const transcriber = createMeetingTranscriber({ modelsDir: '/synthetic', modelId: 'synthetic', workerFactory: fixture.make });
    await transcriber.warm();
    const controller = new AbortController();
    controller.abort();
    await expect(transcriber.transcribe(Buffer.alloc(32, 1), controller.signal)).rejects.toMatchObject({ code: 'interrupted' });
    await transcriber.release();
    expect(await transcriber.transcribe(Buffer.alloc(32, 1), new AbortController().signal)).toBe('chunk 1');
    await transcriber.release();
  });
});

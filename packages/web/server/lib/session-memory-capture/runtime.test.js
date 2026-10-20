import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionMemoryCaptureRuntime } from './runtime.js';
import { parseCaptureResponse } from './prompt.js';

/**
 * The capture runs on a conversation that has already ended, so everything
 * about it is background work: it may not block a turn, may not write when it
 * was told not to, and may not read a folder through a provider that folder
 * did not use.
 *
 * The client is injected, so the tests drive the real runtime against a fake
 * OpenCode rather than a fake server.
 */

const runtimes = [];

const turn = (id, userText, answerText, providerID = 'openrouter-zdr') => ({
  id: `msg_${id}`,
  type: 'user',
  time: { created: 1 },
  text: userText,
});

const assistantTurn = (id, answerText, providerID = 'openrouter-zdr', modelID = 'small') => ({
  id: `msg_${id}`,
  type: 'assistant',
  time: { created: 2, completed: 2 },
  finish: 'stop',
  model: { providerID, id: modelID },
  content: [{ type: 'text', text: answerText }],
});

/** A conversation of one settled turn, in the shape the reader expects. */
const conversation = (turns) => ({
  data: turns,
  cursor: { next: null },
});

const makeRuntime = (overrides = {}) => {
  const stored = [];
  const created = [];
  const memoryRuntime = {
    create: vi.fn(async (target, value) => {
      created.push({ target, value });
      const entry = { id: `mem_${created.length}`, ...value };
      stored.push(entry);
      return { entry, entries: stored, replaced: false };
    }),
  };
  const generateSmallModelText = vi.fn(async () => ({
    text: JSON.stringify({
      memories: [{ type: 'preference', title: 'Kelby decides', body: 'Carter wants the answer first.' }],
    }),
    providerID: 'openrouter-zdr',
    modelID: 'small',
    source: 'session-provider-small',
  }));
  const describeSmallModel = vi.fn(async () => ({
    providerID: 'openrouter-zdr',
    modelID: 'small',
    source: 'session-provider-small',
    hasLogin: true,
    inputCharBudget: 20_000,
    contextTokens: 8_000,
    contextKnown: true,
    outputTokens: 512,
    structuredOutput: null,
    outputTokenLimit: 512,
  }));

  const client = {
    session: { get: vi.fn(async () => ({ id: 'ses_1', parentID: undefined })) },
    // Newest first, the way the reader asks for it.
    message: { list: vi.fn(async () => conversation([
      assistantTurn('b', 'File the certificate first.'),
      turn('a', 'How do we file?'),
    ])) },
  };

  const runtime = createSessionMemoryCaptureRuntime({
    buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
    getOpenCodeAuthHeaders: () => ({}),
    getSmallModelService: async () => ({ describeSmallModel, generateSmallModelText }),
    agentMemoryRuntime: memoryRuntime,
    isAgentMemoryEnabled: async () => true,
    isCaptureEnabled: async () => true,
    resolveProjectId: async () => 'project-1',
    createClient: () => client,
    quietMs: 1,
    ...overrides,
  });
  runtimes.push(runtime);
  return { runtime, memoryRuntime, created, generateSmallModelText, describeSmallModel, client };
};

const idle = (sessionId = 'ses_1', extra = {}) => ({
  type: 'session.idle',
  properties: { sessionID: sessionId, directory: '/work/folder', ...extra },
});

const settle = async (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  while (runtimes.length > 0) runtimes.pop().stop();
  vi.restoreAllMocks();
});

describe('the folder friend learning on its own', () => {
  it('writes what the conversation established into the folder project', async () => {
    const { runtime, created, memoryRuntime } = makeRuntime();
    runtime.processPayload(idle());
    await settle();

    expect(memoryRuntime.create).toHaveBeenCalledTimes(1);
    expect(created[0].target).toEqual({ scope: 'project', projectId: 'project-1' });
    expect(created[0].value.title).toBe('Kelby decides');
    expect(created[0].value.body).toBe('Carter wants the answer first.');
    expect(created[0].value.type).toBe('preference');
  });

  it('captures nothing when the turn was cancelled', async () => {
    const { runtime, memoryRuntime } = makeRuntime();
    runtime.processPayload(idle('ses_1', { aborted: true }));
    await settle();
    expect(memoryRuntime.create).not.toHaveBeenCalled();
  });

  it('captures nothing when memory is off', async () => {
    const { runtime, memoryRuntime } = makeRuntime({ isAgentMemoryEnabled: async () => false });
    runtime.processPayload(idle());
    await settle();
    expect(memoryRuntime.create).not.toHaveBeenCalled();
  });

  it('captures nothing when the user turned capture off', async () => {
    const { runtime, memoryRuntime } = makeRuntime({ isCaptureEnabled: async () => false });
    runtime.processPayload(idle());
    await settle();
    expect(memoryRuntime.create).not.toHaveBeenCalled();
  });

  it('captures nothing for a child session, which is its parent\'s work', async () => {
    const { runtime, memoryRuntime } = makeRuntime({ lineage: { isChild: () => true } });
    runtime.processPayload(idle());
    await settle();
    expect(memoryRuntime.create).not.toHaveBeenCalled();
  });

  it('captures nothing for a directory that is not a folder of the user\'s', async () => {
    const { runtime, memoryRuntime } = makeRuntime({ isCapturableDirectory: () => false });
    runtime.processPayload(idle());
    await settle();
    expect(memoryRuntime.create).not.toHaveBeenCalled();
  });

  it('captures nothing when the folder has no project', async () => {
    const { runtime, memoryRuntime } = makeRuntime({ resolveProjectId: async () => '' });
    runtime.processPayload(idle());
    await settle();
    expect(memoryRuntime.create).not.toHaveBeenCalled();
  });

  it('refuses to read a folder through a provider the folder did not use', async () => {
    const { runtime, memoryRuntime, describeSmallModel } = makeRuntime();
    // The small model service falls back to the default model, which is not
    // the provider the conversation ran on.
    describeSmallModel.mockResolvedValue({
      providerID: 'openai',
      modelID: 'gpt-nano',
      source: 'default',
      hasLogin: true,
      inputCharBudget: 20_000,
      contextTokens: 8_000,
      contextKnown: true,
      outputTokens: 512,
      structuredOutput: null,
      outputTokenLimit: 512,
    });
    runtime.processPayload(idle());
    await settle();
    expect(memoryRuntime.create).not.toHaveBeenCalled();
  });

  it('does not read the same turns twice', async () => {
    const { runtime, memoryRuntime, client } = makeRuntime();
    runtime.processPayload(idle());
    await settle();
    expect(memoryRuntime.create).toHaveBeenCalledTimes(1);

    // The same conversation ends again with nothing new in it.
    client.message.list.mockResolvedValue(conversation([
      assistantTurn('b', 'File the certificate first.'),
      turn('a', 'How do we file?'),
    ]));
    runtime.processPayload(idle());
    await settle();
    expect(memoryRuntime.create).toHaveBeenCalledTimes(1);
  });

  it('stores nothing but still moves on when the conversation holds nothing durable', async () => {
    const { runtime, memoryRuntime, generateSmallModelText } = makeRuntime();
    generateSmallModelText.mockResolvedValue({
      text: '{"memories": []}',
      providerID: 'openrouter-zdr',
      modelID: 'small',
      source: 'session-provider-small',
    });
    runtime.processPayload(idle());
    await settle();
    expect(memoryRuntime.create).not.toHaveBeenCalled();
  });

  it('stops asking once the store says it is full', async () => {
    const { runtime, memoryRuntime } = makeRuntime();
    memoryRuntime.create.mockRejectedValue(new Error('project memory is full (200/200 entries). Consolidate before saving anything else.'));
    runtime.processPayload(idle());
    await settle();
    expect(memoryRuntime.create).toHaveBeenCalledTimes(1);

    runtime.processPayload(idle('ses_2'));
    await settle();
    expect(memoryRuntime.create).toHaveBeenCalledTimes(1);
  });

  it('tells the panels that something was stored', async () => {
    const onMemoryChanged = vi.fn();
    const { runtime } = makeRuntime({ onMemoryChanged });
    runtime.processPayload(idle());
    await settle();
    expect(onMemoryChanged).toHaveBeenCalledWith({ scope: 'project', projectId: 'project-1' });
  });

  it('does nothing after stop', async () => {
    const { runtime, memoryRuntime } = makeRuntime();
    runtime.stop();
    runtime.processPayload(idle());
    await settle();
    expect(memoryRuntime.create).not.toHaveBeenCalled();
  });
});

describe('reading what the model said', () => {
  it('takes the object out of prose', () => {
    const memories = parseCaptureResponse('Sure! Here you go: {"memories": [{"type": "fact", "title": "T", "body": "B"}]} hope that helps');
    expect(memories).toEqual([{ type: 'fact', title: 'T', body: 'B' }]);
  });

  it('takes the object out of a code fence', () => {
    const memories = parseCaptureResponse('```json\n{"memories": [{"type": "fact", "title": "T", "body": "B"}]}\n```');
    expect(memories).toHaveLength(1);
  });

  it('takes a bare array', () => {
    const memories = parseCaptureResponse('[{"type": "reference", "title": "T", "body": "B"}]');
    expect(memories).toEqual([{ type: 'reference', title: 'T', body: 'B' }]);
  });

  it('keeps nothing it cannot store', () => {
    expect(parseCaptureResponse('not json at all')).toEqual([]);
    expect(parseCaptureResponse('{"memories": [{"title": "no body"}]}')).toEqual([]);
    expect(parseCaptureResponse('{"memories": [{"title": "T", "body": "B", "type": "nonsense"}]}')).toEqual([
      { type: 'fact', title: 'T', body: 'B' },
    ]);
  });

  it('reads an empty result as a good result', () => {
    expect(parseCaptureResponse('{"memories": []}')).toEqual([]);
  });
});

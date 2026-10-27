import { describe, expect, it, vi } from 'vitest';

import { createNotificationTriggerRuntime } from './runtime.js';

/**
 * The "ready" push is built from the translated `message.updated` events.
 * v2 splits a turn: the step start names agent and model, the step end
 * carries the finish. What is pinned here: the finish is announced with the
 * agent and model from the start, a user abort announces nothing, and an
 * active goal (which lives in OpenChamber's own metadata) silences the push.
 */
const makeRuntime = ({ metadata = {}, seedRoot = true, settings = {}, focused = false, shouldNotifyCompletion = async () => true } = {}) => {
  const emitDesktopNotification = vi.fn(() => true);
  const broadcastUiNotification = vi.fn();
  const sendPushToAllUiSessions = vi.fn(async () => undefined);
  const sendApnsToAllUiSessions = vi.fn(async () => undefined);
  const runtime = createNotificationTriggerRuntime({
    readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', notifyOnCompletion: true, ...settings }),
    getIsWindowFocused: () => focused,
    prepareNotificationLastMessage: async ({ message }) => message,
    buildTemplateVariables: async () => ({}),
    extractLastMessageText: () => 'done',
    fetchLastAssistantMessageText: async () => 'done',
    resolveNotificationTemplate: () => '',
    shouldApplyResolvedTemplateMessage: () => false,
    emitDesktopNotification,
    broadcastUiNotification,
    sendPushToAllUiSessions,
    sendApnsToAllUiSessions,
    isAnyInteractiveClientVisible: () => false,
    buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    readSessionMetadata: async () => metadata,
    shouldNotifyCompletion,
  });
  const originalTrigger = runtime.maybeSendPushForTrigger;
  runtime.maybeSendPushForTrigger = async (payload) => {
    const sessionID = payload.properties?.sessionID;
    if (seedRoot && sessionID && sessionID !== 'ses_child') await originalTrigger({ type: 'session.created', properties: { info: { id: sessionID } } });
    return originalTrigger(payload);
  };
  return { runtime, emitDesktopNotification, broadcastUiNotification, sendPushToAllUiSessions, sendApnsToAllUiSessions };
};

const stepStarted = (sessionID, id) => ({
  type: 'message.updated',
  properties: { sessionID, info: { id, sessionID, role: 'assistant', agent: 'build', providerID: 'anthropic', modelID: 'claude-sonnet-5', time: { created: 1 } } },
});
const stepEnded = (sessionID, id) => ({
  type: 'message.updated',
  properties: { sessionID, info: { id, sessionID, role: 'assistant', finish: 'stop', time: { completed: 2 } } },
});

const turnEnded = (sessionID) => ({ type: 'session.idle', properties: { sessionID } });

describe('ready notification on v2 step events', () => {
  it('announces the turn end with the agent and model of its last step', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime, emitDesktopNotification } = makeRuntime();

    await runtime.maybeSendPushForTrigger(stepStarted('ses_1', 'msg_1'));
    expect(emitDesktopNotification).not.toHaveBeenCalled();

    // A step's `stop` is not the end of the turn: the execution may still
    // drain steering input, so only its idle event announces readiness.
    await runtime.maybeSendPushForTrigger(stepEnded('ses_1', 'msg_1'));
    expect(emitDesktopNotification).not.toHaveBeenCalled();

    await runtime.maybeSendPushForTrigger(turnEnded('ses_1'));
    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
    expect(emitDesktopNotification.mock.calls[0][0]).toMatchObject({
      kind: 'ready',
      title: 'Build agent is ready',
      body: 'Claude Sonnet 5 completed the task',
    });
  });

  it('announces nothing for a user abort', async () => {
    const { runtime, emitDesktopNotification } = makeRuntime();

    await runtime.maybeSendPushForTrigger({
      type: 'session.idle',
      properties: { sessionID: 'ses_2', aborted: true, reason: 'user', error: { name: 'MessageAbortedError', message: 'aborted' } },
    });

    expect(emitDesktopNotification).not.toHaveBeenCalled();
  });

  it('indexes a companion result when goal mode is disabled despite stale active metadata', async () => {
    const considerCompletion = vi.fn(async () => false);
    const { runtime, emitDesktopNotification } = makeRuntime({
      settings: { sessionGoalEnabled: false },
      metadata: { openchamber: { goal: { id: 'g', status: 'active' }, companion: { taskId: 'companion:project-monitor' } } },
      shouldNotifyCompletion: considerCompletion,
    });
    await runtime.maybeSendPushForTrigger(stepStarted('ses_monitor', 'msg_monitor'));
    await runtime.maybeSendPushForTrigger(stepEnded('ses_monitor', 'msg_monitor'));
    expect(considerCompletion).not.toHaveBeenCalled();
    await runtime.maybeSendPushForTrigger(turnEnded('ses_monitor'));
    expect(considerCompletion).toHaveBeenCalledWith('ses_monitor');
    // The coordinator persists it and defers the alert through quiet hours.
    expect(emitDesktopNotification).not.toHaveBeenCalled();
  });

  it('stays quiet while a goal from OpenChamber\'s own metadata is active', async () => {
    const { runtime, emitDesktopNotification } = makeRuntime({
      metadata: { openchamber: { goal: { id: 'g', status: 'active', objective: 'x' } } },
    });

    await runtime.maybeSendPushForTrigger(stepStarted('ses_3', 'msg_3'));
    await runtime.maybeSendPushForTrigger(stepEnded('ses_3', 'msg_3'));
    await runtime.maybeSendPushForTrigger(turnEnded('ses_3'));

    expect(emitDesktopNotification).not.toHaveBeenCalled();
  });
});

describe('ready notification while background subagents run', () => {
  const stubOpenCode = ({ active, children }) => {
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/session/active') return Response.json({ data: active() });
      if (url.pathname === '/api/session') return Response.json({ data: children, cursor: {} });
      return Response.json({});
    }));
  };

  it('stays silent on the pause and announces the real turn end', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let active = { ses_child: { type: 'running' } };
    stubOpenCode({ active: () => active, children: [{ id: 'ses_child', parentID: 'ses_1' }] });
    const { runtime, emitDesktopNotification } = makeRuntime();

    await runtime.maybeSendPushForTrigger(stepStarted('ses_1', 'msg_1'));
    await runtime.maybeSendPushForTrigger(turnEnded('ses_1'));
    expect(emitDesktopNotification).not.toHaveBeenCalled();

    // The subagent finished and OpenCode ran the parent again with its result.
    active = {};
    await runtime.maybeSendPushForTrigger(turnEnded('ses_1'));
    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('announces the idle when the subagent check cannot be made', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    const { runtime, emitDesktopNotification } = makeRuntime();

    await runtime.maybeSendPushForTrigger(stepStarted('ses_1', 'msg_1'));
    await runtime.maybeSendPushForTrigger(turnEnded('ses_1'));
    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe('push content in enterprise mode', () => {
  const makePushRuntime = () => {
    const sendPushToAllUiSessions = vi.fn(async () => undefined);
    const sendApnsToAllUiSessions = vi.fn(async () => undefined);
    const runtime = createNotificationTriggerRuntime({
      readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', notifyOnCompletion: true }),
      prepareNotificationLastMessage: async ({ message }) => message,
      buildTemplateVariables: async () => ({ session_name: 'Fix the billing export' }),
      extractLastMessageText: () => 'The customer table is migrated',
      fetchLastAssistantMessageText: async () => 'The customer table is migrated',
      resolveNotificationTemplate: (template, variables) => template.replace('{last_message}', variables.last_message ?? ''),
      shouldApplyResolvedTemplateMessage: () => true,
      emitDesktopNotification: vi.fn(() => true),
      broadcastUiNotification: vi.fn(),
      sendPushToAllUiSessions,
      sendApnsToAllUiSessions,
      isAnyInteractiveClientVisible: () => false,
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      readSessionMetadata: async () => ({}),
    });
    return { runtime, sendPushToAllUiSessions, sendApnsToAllUiSessions };
  };

  it('sends only the scenario title and the deep link, on both channels', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
    process.env.OPENCHAMBER_ENTERPRISE_MODE = 'true';
    try {
      const { runtime, sendPushToAllUiSessions, sendApnsToAllUiSessions } = makePushRuntime();
      await runtime.maybeSendPushForTrigger({ type: 'session.created', properties: { info: { id: 'ses_e' } } });
      await runtime.maybeSendPushForTrigger(stepStarted('ses_e', 'msg_e'));
      await runtime.maybeSendPushForTrigger(turnEnded('ses_e'));

      const web = sendPushToAllUiSessions.mock.calls[0][0];
      expect(web).toMatchObject({ title: 'Agent response is ready', body: '', data: { sessionId: 'ses_e', type: 'ready' } });
      expect(web.data.sessionName).toBeUndefined();
      expect(sendApnsToAllUiSessions.mock.calls[0][0]).toMatchObject({ title: 'Agent response is ready', body: '' });
      expect(JSON.stringify([web, sendApnsToAllUiSessions.mock.calls[0][0]])).not.toMatch(/billing|customer/);
    } finally {
      delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
      vi.unstubAllGlobals();
    }
  });
});

describe('full-session notification policy across delivery channels', () => {
  it.each([undefined, 'ses_parent'])('does not dispatch unknown or child sessions: %s', async (parentID) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    const { runtime, emitDesktopNotification, broadcastUiNotification, sendPushToAllUiSessions, sendApnsToAllUiSessions } = makeRuntime({ seedRoot: false });
    if (parentID) await runtime.maybeSendPushForTrigger({ type: 'session.created', properties: { info: { id: 'ses_child', parentID } } });
    await runtime.maybeSendPushForTrigger(turnEnded('ses_child'));
    await runtime.maybeSendPushForTrigger({ type: 'session.error', properties: { sessionID: 'ses_child', error: 'failed' } });
    await runtime.maybeSendPushForTrigger({ type: 'form.created', properties: { sessionID: 'ses_child', form: { title: 'Question' } } });
    await runtime.maybeSendPushForTrigger({ type: 'permission.asked', properties: { sessionID: 'ses_child', id: 'p1', action: 'read' } });
    await new Promise(resolve => setTimeout(resolve, 650));
    await runtime.sendGoalSettlePush({ sessionId: 'ses_child', status: 'complete', title: 'Goal complete' });
    for (const channel of [emitDesktopNotification, broadcastUiNotification, sendPushToAllUiSessions, sendApnsToAllUiSessions]) expect(channel).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('notifies a standalone root on desktop, web push and iOS APNs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
    const { runtime, emitDesktopNotification, broadcastUiNotification, sendPushToAllUiSessions, sendApnsToAllUiSessions } = makeRuntime({ seedRoot: false });
    await runtime.maybeSendPushForTrigger({ type: 'session.created', properties: { info: { id: 'ses_root' } } });
    await runtime.maybeSendPushForTrigger(turnEnded('ses_root'));
    for (const channel of [emitDesktopNotification, broadcastUiNotification, sendPushToAllUiSessions, sendApnsToAllUiSessions]) expect(channel).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('keeps root error and attention alerts without enabling child alerts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
    const { runtime, emitDesktopNotification, sendApnsToAllUiSessions } = makeRuntime();
    await runtime.maybeSendPushForTrigger({ type: 'session.error', properties: { sessionID: 'ses_root', error: 'failed' } });
    await runtime.maybeSendPushForTrigger({ type: 'form.created', properties: { sessionID: 'ses_root', form: { title: 'Question' } } });
    await runtime.maybeSendPushForTrigger({ type: 'permission.asked', properties: { sessionID: 'ses_root', id: 'p1', action: 'read' } });
    await new Promise(resolve => setTimeout(resolve, 650));
    expect(emitDesktopNotification.mock.calls.map(([payload]) => payload.kind)).toEqual(['error', 'question', 'permission']);
    expect(sendApnsToAllUiSessions).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });

  it('keeps the existing focused-root notification preference', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
    const { runtime, emitDesktopNotification, sendApnsToAllUiSessions } = makeRuntime({ focused: true, settings: { notificationMode: 'hidden-only' } });
    await runtime.maybeSendPushForTrigger(turnEnded('ses_root'));
    expect(emitDesktopNotification).not.toHaveBeenCalled();
    expect(sendApnsToAllUiSessions).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('subagent finish with subagent notifications off', () => {
  const makeSubtaskRuntime = () => {
    const emitDesktopNotification = vi.fn(() => true);
    const runtime = createNotificationTriggerRuntime({
      readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', notifyOnCompletion: true, notifyOnSubtasks: false }),
      prepareNotificationLastMessage: async ({ message }) => message,
      buildTemplateVariables: async () => ({}),
      extractLastMessageText: () => 'done',
      fetchLastAssistantMessageText: async () => 'done',
      resolveNotificationTemplate: () => '',
      shouldApplyResolvedTemplateMessage: () => false,
      emitDesktopNotification,
      broadcastUiNotification: vi.fn(),
      sendApnsToAllUiSessions: vi.fn(async () => undefined),
      isAnyInteractiveClientVisible: () => true,
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      readSessionMetadata: async () => ({}),
    });
    return { runtime, emitDesktopNotification };
  };

  // OpenCode answers `GET /api/session/:id` as `{ data }` with no `location`.
  const stubSessionRecord = () => {
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/session/active') return Response.json({ data: {} });
      if (url.pathname === '/api/session/ses_child') return Response.json({ data: { id: 'ses_child', parentID: 'ses_parent' } });
      return Response.json({ data: [], cursor: {} });
    }));
  };

  it('reads the parent from the session record envelope', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubSessionRecord();
    const { runtime, emitDesktopNotification } = makeSubtaskRuntime();

    await runtime.maybeSendPushForTrigger(stepStarted('ses_child', 'msg_c'));
    await runtime.maybeSendPushForTrigger(turnEnded('ses_child'));
    expect(emitDesktopNotification).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('a partial session update does not erase a known parent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    const { runtime, emitDesktopNotification } = makeSubtaskRuntime();

    await runtime.maybeSendPushForTrigger({ type: 'session.created', properties: { sessionID: 'ses_child', info: { id: 'ses_child', parentID: 'ses_parent' } } });
    // Usage updates arrive as `session.updated` with a partial record.
    await runtime.maybeSendPushForTrigger({ type: 'session.updated', properties: { sessionID: 'ses_child', info: { id: 'ses_child', cost: 1 } } });
    await runtime.maybeSendPushForTrigger(stepStarted('ses_child', 'msg_c'));
    await runtime.maybeSendPushForTrigger(turnEnded('ses_child'));
    expect(emitDesktopNotification).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('companion ready delivery gate', () => {
  it('silences ready channels together while retaining new updates', async () => {
    const { runtime, emitDesktopNotification, broadcastUiNotification, sendPushToAllUiSessions, sendApnsToAllUiSessions } = makeRuntime({ shouldNotifyCompletion: async () => false });
    await runtime.maybeSendPushForTrigger(stepStarted('ses_quiet', 'msg_quiet'));
    await runtime.maybeSendPushForTrigger(stepEnded('ses_quiet', 'msg_quiet'));
    await runtime.maybeSendPushForTrigger(turnEnded('ses_quiet'));
    for (const channel of [emitDesktopNotification, broadcastUiNotification, sendPushToAllUiSessions, sendApnsToAllUiSessions]) expect(channel).not.toHaveBeenCalled();
    const normal = makeRuntime();
    await normal.runtime.maybeSendPushForTrigger(stepStarted('ses_new', 'msg_new'));
    await normal.runtime.maybeSendPushForTrigger(turnEnded('ses_new'));
    expect(normal.sendPushToAllUiSessions).toHaveBeenCalledTimes(1);
  });
});

describe('durable companion notification attempts', () => {
  it('uses the ordinary channels and obeys notification opt-out', async () => {
    const entry = { id: 'ses_update', title: 'Useful lead', excerpt: 'A verified change' };
    const allowed = makeRuntime();
    expect(await allowed.runtime.sendCompanionUpdate('project', entry)).toBe(true);
    expect(allowed.emitDesktopNotification).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'ses_update', tag: 'companion-ses_update' }));
    expect(allowed.sendPushToAllUiSessions).toHaveBeenCalledTimes(1);
    expect(allowed.sendApnsToAllUiSessions).toHaveBeenCalledTimes(1);
    const disabled = makeRuntime({ settings: { nativeNotificationsEnabled: false } });
    expect(await disabled.runtime.sendCompanionUpdate('project', entry)).toBe(false);
    expect(disabled.sendApnsToAllUiSessions).not.toHaveBeenCalled();
  });
});

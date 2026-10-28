import { sendMessageStreamWsEvent, sendMessageStreamWsFrame, sendSerializedMessageStreamWsFrame, serializeMessageStreamWsEvent } from './protocol.js';

function shouldTriggerUpstreamHealthCheck(upstream) {
  if (!upstream) {
    return true;
  }

  if (!upstream.body) {
    return upstream.ok || upstream.status >= 500;
  }

  return upstream.status >= 500;
}

export function createGlobalMessageStreamWsBridge({
  globalHub,
  ownsGlobalHub,
  wsClients,
  processForwardedEventPayload,
  triggerHealthCheck,
  heartbeatIntervalMs,
  filterEvent = null,
}) {
  const clients = new Set();
  const clientLastEventIds = new Map();
  const readyClients = new Set();
  const deliveredIds = new WeakMap();
  let deliveryQueue = Promise.resolve();
  const ordered = (work) => {
    if (!filterEvent) { void work(); return; }
    deliveryQueue = deliveryQueue.then(work).catch(() => {});
  };
  const sendEvent = (socket, frame, eventId) => {
    if (filterEvent && eventId) {
      let ids = deliveredIds.get(socket);
      if (!ids) { ids = new Set(); deliveredIds.set(socket, ids); }
      if (ids.has(eventId)) return true;
      if (ids.size >= 4096) ids.delete(ids.values().next().value);
      ids.add(eventId);
    }
    return sendSerializedMessageStreamWsFrame(socket, frame);
  };

  const removeClient = (socket) => {
    clients.delete(socket);
    clientLastEventIds.delete(socket);
    readyClients.delete(socket);
    wsClients.delete(socket);
  };

  const replayEvents = async (socket, entries) => {
    for (const entry of entries) {
      let serializedFrame = entry.serializedFrame;
      if (filterEvent) {
        const frame = JSON.parse(entry.serializedFrame);
        const visible = await filterEvent(frame.payload, { directory: frame.directory });
        if (!visible) continue;
        if (visible !== frame.payload) serializedFrame = serializeMessageStreamWsEvent(visible, frame);
      }
      const sent = sendEvent(socket, serializedFrame, entry.eventId);
      if (!sent) {
        removeClient(socket);
        return;
      }
    }
  };

  const markReady = async (socket, requestedLastEventId) => {
    if (socket.readyState !== 1) {
      return;
    }

    globalHub.flushPending();
    const replay = globalHub.replayAfter(requestedLastEventId);
    const ready = { type: 'ready', scope: 'global' };
    if (replay === null) ready.replayReset = true;
    const sent = sendMessageStreamWsFrame(socket, ready);
    if (!sent) {
      removeClient(socket);
      return;
    }

    readyClients.add(socket);
    wsClients.add(socket);
    if (replay !== null) await replayEvents(socket, replay);
  };

  const stopHubIfUnused = () => {
    if (ownsGlobalHub && clients.size === 0) {
      globalHub.stop();
    }
  };

  const closeClientsWithInitialError = ({ message, closeReason = message, triggerHealthCheckFor = null }) => {
    for (const socket of Array.from(clients)) {
      sendMessageStreamWsFrame(socket, { type: 'error', message });
      try {
        socket.close(1011, closeReason);
      } catch {
      }
      removeClient(socket);
    }

    if (triggerHealthCheckFor === true || (triggerHealthCheckFor && shouldTriggerUpstreamHealthCheck(triggerHealthCheckFor))) {
      triggerHealthCheck?.();
    }

    if (ownsGlobalHub) {
      globalHub.stop();
    }
  };

  // Browser clients take the events of isolated spaces too: each frame carries its directory,
  // and a space's directory is one more project directory to the UI.
  const unsubscribeEvent = globalHub.subscribeEvent((event) => {
    ordered(async () => {
    const { payload } = event;
    const visible = filterEvent ? await filterEvent(payload, { directory: event.directory }) : payload;
    if (!visible) return;
    const serializedEvent = readyClients.size ? visible === payload ? event.serialize() : serializeMessageStreamWsEvent(visible, event) : null;
    for (const socket of Array.from(clients)) {
      if (!readyClients.has(socket)) {
        continue;
      }
      const sent = sendEvent(socket, serializedEvent, event.eventId);
      if (!sent) {
        removeClient(socket);
      }
    }

    const synthetic = [];
    processForwardedEventPayload(visible, (syntheticPayload) => { synthetic.push(syntheticPayload); });
    for (const syntheticPayload of synthetic) {
      const safeSynthetic = filterEvent ? await filterEvent(syntheticPayload) : syntheticPayload;
      if (!safeSynthetic) continue;
      if (readyClients.size === 0) return;
      const serializedFrame = serializeMessageStreamWsEvent(safeSynthetic, { directory: 'global' });
      for (const socket of Array.from(clients)) {
        if (!readyClients.has(socket)) {
          continue;
        }
        const sent = sendSerializedMessageStreamWsFrame(socket, serializedFrame);
        if (!sent) {
          removeClient(socket);
        }
      }
    }
    });
  }, { spaces: true });

  const unsubscribeStatus = globalHub.subscribeStatus((status) => {
    if (status.type === 'connect') {
      for (const socket of Array.from(clients)) {
        if (!readyClients.has(socket)) {
          ordered(() => markReady(socket, clientLastEventIds.get(socket) ?? ''));
          continue;
        }

        if (status.wasReady) {
          const sent = sendMessageStreamWsFrame(socket, {
            type: 'ready',
            scope: 'global',
          });
          if (!sent) {
            removeClient(socket);
          }
        }
      }
      return;
    }

    if (status.type === 'initial-error') {
      const error = status.error;
      if (error?.type === 'upstream_unavailable') {
        closeClientsWithInitialError({
          message: `OpenCode event stream unavailable (${error.status})`,
          closeReason: 'OpenCode event stream unavailable',
          triggerHealthCheckFor: error.response,
        });
        return;
      }

      closeClientsWithInitialError({
        message: status.buildUrlFailed ? 'OpenCode service unavailable' : 'Failed to connect to OpenCode event stream',
        closeReason: status.buildUrlFailed ? 'OpenCode service unavailable' : 'Failed to connect to OpenCode event stream',
        triggerHealthCheckFor: !status.buildUrlFailed,
      });
      return;
    }

    if (status.type === 'error' && status.error?.type === 'stream_error') {
      console.warn('Message stream WS proxy error:', status.error.error);
    }
  });

  const accept = (socket, { requestedLastEventId = '' } = {}) => {
    const pingInterval = setInterval(() => {
      if (socket.readyState !== 1) {
        return;
      }

      try {
        socket.ping();
      } catch {
      }
    }, heartbeatIntervalMs);

    const heartbeatInterval = setInterval(() => {
      if (!globalHub.isConnected()) {
        return;
      }

      sendMessageStreamWsEvent(socket, { type: 'openchamber:heartbeat', timestamp: Date.now() }, { directory: 'global' });
    }, heartbeatIntervalMs);

    socket.on('close', () => {
      clearInterval(pingInterval);
      clearInterval(heartbeatInterval);
      removeClient(socket);
      stopHubIfUnused();
    });

    socket.on('error', () => {
      void 0;
    });

    clients.add(socket);
    clientLastEventIds.set(socket, requestedLastEventId);
    globalHub.start();
    if (globalHub.isConnected()) {
      ordered(() => markReady(socket, requestedLastEventId));
    }
  };

  const close = () => {
    unsubscribeEvent();
    unsubscribeStatus();
    if (ownsGlobalHub) {
      globalHub.stop();
    }
    for (const socket of Array.from(clients)) {
      removeClient(socket);
    }
  };

  return {
    accept,
    close,
  };
}

import path from 'node:path';
import { queryHealthEvidence } from './whoop.js';
import { getHealthStore, healthQuerySchema } from './store.js';

/** A health question cannot silently route private records to another provider. */
export function createHealthActions({ dataDir, readSession }) {
  const store = getHealthStore(dataDir);
  return {
    execute: async (action, input, contextDirectory, options = {}) => {
      const state = await store.read();
      const session = options.contextSessionId ? await readSession(options.contextSessionId) : null;
      if (!state.approval?.enabled || !session || session.model?.providerID !== state.approval.providerID
        || path.resolve(contextDirectory || '.') !== path.resolve(state.approval.directory)
        || path.resolve(session.location?.directory || session.directory || '.') !== path.resolve(state.approval.directory)) {
        const error = new Error('Health data is available only in the approved OpenAI health conversation');
        error.statusCode = 403; throw error;
      }
      if (action === 'health.query') {
        const { start, end, metric, limit } = input;
        return queryHealthEvidence(store, healthQuerySchema.parse({ start, end, metric, limit }));
      }
      throw new Error('Unsupported health action');
    },
  };
}

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getSmallModelClient } from '../small-model/client.js';
import { readConfigLayers } from '../opencode/shared.js';
import { extractAllowedProviders } from '../session-memory-capture/providers.js';

const providerList = z.object({ data: z.array(z.object({ id: z.string() }).passthrough()) });
const modelList = z.object({ data: z.array(z.object({ id: z.string(), providerID: z.string() }).passthrough()) });

/** Hash the running directory-scoped provider/model configuration, never return its credentials. */
export async function resolveNativeProviderBinding(directory, session, { readLayers = readConfigLayers, getClient = getSmallModelClient } = {}) {
  try {
    const config = readLayers(directory).mergedConfig;
    if (!config) throw new Error('Native reader cannot verify this directory configuration.');
    const allowed = extractAllowedProviders(config);
    if (allowed.some((provider) => /zdr/i.test(provider))) {
      const error = new Error('Native app grants are excluded from ZDR-bound directories.');
      error.statusCode = 403;
      throw error;
    }
    const client = getClient(directory);
    if (!client) throw new Error('Native reader cannot verify the active provider.');
    const [providers, models] = await Promise.all([client.provider.list(), client.model.list()]);
    const provider = providerList.parse(providers).data.find((entry) => entry.id === session.model?.providerID);
    const model = modelList.parse(models).data.find((entry) => entry.id === session.model?.id && entry.providerID === provider?.id);
    if (!provider || !model || (allowed.length > 0 && !allowed.includes(provider.id))) throw new Error('Native reader cannot verify the active directory provider and model.');
    // A changed endpoint, model override, provider adapter or header invalidates approval.
    return createHash('sha256').update(JSON.stringify({ provider, model })).digest('hex');
  } catch (error) {
    if (error?.statusCode === 403) throw error;
    throw new Error('Native reader cannot verify the active provider configuration.');
  }
}

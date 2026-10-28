/**
 * Which providers a folder may use.
 *
 * A folder's own OpenCode configuration says so: `provider.use` policies that
 * deny everything and allow the one provider the folder is bound to. That is
 * the same policy the server enforces on every send, so the capture and the
 * agent cannot disagree about where a folder's work may go.
 *
 * An empty list means the folder is not bound to one provider, and anything
 * the folder already uses is fair game.
 */

import { readConfigLayers } from '../opencode/shared.js';

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const extractAllowedProviders = (config) => {
  const policies = Array.isArray(config?.experimental?.policies) ? config.experimental.policies : [];
  const providerPolicies = policies.filter((policy) => isRecord(policy) && policy.action === 'provider.use');
  const deniesAll = providerPolicies.some((policy) => policy.effect === 'deny' && policy.resource === '*');
  if (!deniesAll) return [];
  const allowed = [...new Set(
    providerPolicies
      .filter((policy) => policy.effect === 'allow' && typeof policy.resource === 'string' && policy.resource && policy.resource !== '*')
      .map((policy) => policy.resource),
  )];
  return allowed;
};

/**
 * The providers a directory is bound to, or an empty list when it is not
 * bound to one.
 */
export const resolveDirectoryAllowedProviders = async (directory) => {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('Directory is required');
  const layers = readConfigLayers(directory);
  if (layers.layerErrors.length) throw new Error('Provider policy could not be read');
  return extractAllowedProviders(layers.mergedConfig);
};

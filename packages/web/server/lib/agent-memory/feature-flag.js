/**
 * Whether agent memory exists at all in this build.
 *
 * Open Carter ships it on. A folder friend is supposed to carry what the
 * earlier conversations in that folder worked out, and a memory the user
 * cannot see is a memory nobody can rely on: the feature is only a pillar if
 * it is standing there by default. The kill switch is still here —
 * `OPENCHAMBER_MEMORY_ENABLE=0` takes the tool, the routes, the session index
 * and the panel away together, which is the only way to ship dark.
 *
 * Read per call rather than captured at import, so a process started with the
 * variable set is the only thing that decides — no build step bakes it in.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

export const isAgentMemoryFeatureAvailable = () => {
  const raw = process.env.OPENCHAMBER_MEMORY_ENABLE;
  // Unset means on: this build's default, not an accident.
  if (typeof raw !== 'string' || raw.trim() === '') return true;
  const value = raw.trim().toLowerCase();
  if (FALSY.has(value)) return false;
  return TRUTHY.has(value);
};

/**
 * Whether the stored setting asks for the memory tool.
 *
 * Absent means on, for the same reason the feature gate defaults to on. An
 * explicit `false` is the user turning it off, and that is honoured.
 */
export const isMemoryToolEnabledBySettings = (settings) => settings?.agentMemoryToolEnabled !== false;

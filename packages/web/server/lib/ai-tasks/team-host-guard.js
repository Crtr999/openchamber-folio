import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const freeTeamGuardDirectory = directory => path.join(directory, '.opencode/plugins/open-carter-free-team');
// Hash of the reviewed standalone prefix. Bundling may reformat function source;
// runtime attestation must use this reviewed digest, not bundled toString().
const reviewedPrefixHash = '77b782d78432c0bf76efc975530c2aa8ce518b39cc17ce1d79890efaa78b0722';
const guardArguments = ({ directory, model, models, manager, specialists }) => JSON.stringify({ directory, model, models, profiles: [manager, ...specialists] });

/** Exact host-produced source, with no dependency resolution or mutable options. */
export async function freeTeamGuardSource({ directory, model, models, manager, specialists }) {
  // Provision from reviewed source, not a transformed/bundled function body.
  // This generator is a setup utility; runtime verification needs no source file.
  const source = await readFile(new URL('./team-free-guard.js', import.meta.url), 'utf8');
  const start = source.indexOf('export function createFreeTeamGuard(');
  if (start < 0) throw new Error('Free guard source unavailable');
  const prefix = `export default (${source.slice(start + 'export '.length).trim()})`;
  if (createHash('sha256').update(prefix).digest('hex') !== reviewedPrefixHash) throw new Error('Free guard changed; review and update its attestation before activation.');
  return `${prefix}(${guardArguments({ directory, model, models, manager, specialists })});\n`;
}

/** The executor separately requires this exact plugin to be active. */
export async function verifyFreeTeamExecution(input) {
  const file = path.join(freeTeamGuardDirectory(input.directory), 'index.mjs');
  try {
    if (await realpath(file) !== file) return false;
    const source = await readFile(file, 'utf8');
    const suffix = `(${guardArguments(input)});\n`;
    return source.endsWith(suffix) && createHash('sha256').update(source.slice(0, -suffix.length)).digest('hex') === reviewedPrefixHash;
  } catch { return false; }
}

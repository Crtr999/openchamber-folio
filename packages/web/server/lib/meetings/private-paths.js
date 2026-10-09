import fs from 'node:fs/promises';
import path from 'node:path';

// Deliberately process-lifetime: disposing a service does not make its records public.
const directories = new Set();

export const registerPrivateMeetingDirectory = (directory) => {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.normalize(directory) !== directory) {
    throw new Error('Private meeting directory must be a normalized absolute path');
  }
  directories.add(directory);
};

const contains = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

// Resolve existing ancestors too: new uploads and mkdir must not bypass a symlink.
const canonicalPath = async (target) => {
  let ancestor = path.resolve(target);
  const missing = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(ancestor), ...missing);
    } catch (error) {
      const parent = path.dirname(ancestor);
      if (!['ENOENT', 'ENOTDIR'].includes(error.code) || parent === ancestor) throw error;
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
};

export const isPrivateMeetingPath = async (target, { includeAncestors = false } = {}) => {
  if (directories.size === 0) return false;
  const resolved = path.resolve(target);
  const overlaps = (root, candidate) => contains(root, candidate) || (includeAncestors && contains(candidate, root));
  for (const directory of directories) {
    if (overlaps(directory, resolved)) return true;
  }
  // Fresh resolution, never a TTL cache of a security decision.
  const canonical = await canonicalPath(resolved);
  for (const directory of directories) {
    if (overlaps(await canonicalPath(directory), canonical)) return true;
  }
  return false;
};

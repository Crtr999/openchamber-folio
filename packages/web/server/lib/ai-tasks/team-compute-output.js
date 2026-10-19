import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, realpathSync, writeSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const TEAM_OUTPUT_DIRECTORY = 'team-output';
const teamOutputSchema = z.object({
  filename: z.string().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*\.(?:txt|md|csv|json)$/),
  content: z.string().max(262144),
}).strict();
export const teamOutputInput = z.toJSONSchema(teamOutputSchema);
const readOutputSchema = teamOutputSchema.pick({ filename: true }).strict();
export const teamReadOutputInput = z.toJSONSchema(readOutputSchema);
const artifactReceipt = z.object({ path: z.string(), verified: z.literal(true), sha256: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().min(0).max(262144) });
const sameDirectory = (a, b) => a.dev === b.dev && a.ino === b.ino && b.isDirectory() && !b.isSymbolicLink();

/** Receipt comes only from the host's fresh current-run scan, never model input. */
export function createTeamOutputReader({ directory, exclusiveOutputOwnership }) {
  if (exclusiveOutputOwnership !== true) throw new Error('Exclusive host output ownership required');
  const root = z.string().min(1).parse(directory);
  if (!path.isAbsolute(root) || realpathSync(root) !== root) throw new Error('Canonical project directory required');
  const output = path.join(root, TEAM_OUTPUT_DIRECTORY);
  const rootIdentity = lstatSync(root);
  const outputIdentity = lstatSync(output);
  const verify = () => {
    if (realpathSync(root) !== root || realpathSync(output) !== output
      || !sameDirectory(rootIdentity, lstatSync(root)) || !sameDirectory(outputIdentity, lstatSync(output))) throw new Error('Output directory scope changed');
  };
  verify();
  return (input, { signal, receipt } = {}) => {
    signal?.throwIfAborted();
    const { filename } = readOutputSchema.parse(input);
    const expected = artifactReceipt.parse(receipt);
    const target = path.join(output, filename);
    if (expected.path !== target) throw new Error('Current task artifact receipt required');
    verify();
    let fd;
    try {
      fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size !== expected.sizeBytes) throw new Error('Unsafe output artifact');
      const bytes = Buffer.alloc(expected.sizeBytes);
      let count = 0;
      while (count < bytes.length) {
        signal?.throwIfAborted();
        const read = readSync(fd, bytes, count, bytes.length - count, count);
        if (!read) throw new Error('Output artifact changed');
        count += read;
      }
      const after = fstatSync(fd);
      const current = lstatSync(target);
      verify();
      if (current.isSymbolicLink() || current.nlink !== 1 || current.dev !== before.dev || current.ino !== before.ino
        || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw new Error('Output artifact changed');
      signal?.throwIfAborted();
      return { path: target, relativePath: `${TEAM_OUTPUT_DIRECTORY}/${filename}`, bytes: bytes.length, sha256: expected.sha256, content: bytes.toString('utf8') };
    } finally { if (fd !== undefined) closeSync(fd); }
  };
}

/** Requires a trusted host-owned root, unavailable to shell/code tools. See TEAM_TOOLS.md. */
export function createTeamOutputWriter({ directory, exclusiveOutputOwnership }) {
  if (exclusiveOutputOwnership !== true) throw new Error('Exclusive host output ownership required');
  const root = z.string().min(1).parse(directory);
  if (!path.isAbsolute(root) || realpathSync(root) !== root) throw new Error('Canonical project directory required');
  const output = path.join(root, TEAM_OUTPUT_DIRECTORY);
  const rootIdentity = lstatSync(root);
  const outputIdentity = lstatSync(output);
  const verify = () => {
    if (realpathSync(root) !== root || realpathSync(output) !== output
      || !sameDirectory(rootIdentity, lstatSync(root)) || !sameDirectory(outputIdentity, lstatSync(output))) throw new Error('Output directory scope changed');
  };
  verify();
  return (input, { signal } = {}) => {
    signal?.throwIfAborted();
    const args = teamOutputSchema.parse(input);
    const bytes = Buffer.from(args.content, 'utf8');
    if (bytes.length > 262144) throw new Error('Output byte limit exceeded');
    verify();
    // Reject every unexpected entry. Only our flat, bounded regular deliverables belong here.
    const entries = readdirSync(output);
    if (entries.length >= 128) throw new Error('Output file count limit exceeded');
    let total = 0;
    for (const entry of entries) {
      const stat = lstatSync(path.join(output, entry));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe output entry');
      total += stat.size;
    }
    if (total + bytes.length > 8 * 1024 * 1024) throw new Error('Output directory byte limit exceeded');
    const target = path.join(output, args.filename);
    if (path.dirname(target) !== output) throw new Error('Output path outside scope');
    signal?.throwIfAborted();
    let fd;
    try {
      fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      verify();
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe output file');
      let written = 0;
      while (written < bytes.length) {
        signal?.throwIfAborted();
        const count = writeSync(fd, bytes, written, bytes.length - written);
        if (count <= 0) throw new Error('Output write incomplete');
        written += count;
      }
      fsyncSync(fd);
      verify();
      return { version: 1, path: target, relativePath: `${TEAM_OUTPUT_DIRECTORY}/${args.filename}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    } finally {
      if (fd !== undefined) closeSync(fd);
      // Never unlink on error: a concurrent host replacement must not be deleted.
      // A failed write may leave a partial create-only file, with no success receipt.
    }
  };
}

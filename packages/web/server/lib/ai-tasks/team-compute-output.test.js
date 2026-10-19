import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, renameSync, writeFileSync, linkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTeamOutputWriter, createTeamOutputReader } from './team-compute-output.js';

const cleanup = [];
afterEach(() => { for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'team-output-')));
  cleanup.push(directory);
  const output = path.join(directory, 'team-output');
  const outside = path.join(directory, 'outside');
  mkdirSync(output); mkdirSync(outside);
  return { directory, output, outside, write: createTeamOutputWriter({ directory, exclusiveOutputOwnership: true }) };
}

describe('create-only team deliverables', () => {
  it('writes real bytes and returns a verified path and SHA-256 receipt', () => {
    const f = fixture();
    const receipt = f.write({ filename: 'results.csv', content: 'week,value\n1,142\n' });
    const bytes = readFileSync(receipt.path);
    expect(receipt.path).toBe(path.join(f.output, 'results.csv'));
    expect(receipt.bytes).toBe(bytes.length);
    expect(receipt.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(() => f.write({ filename: 'results.csv', content: 'overwrite' })).toThrow();
    expect(readFileSync(receipt.path, 'utf8')).toBe('week,value\n1,142\n');
  });
  it('refuses traversal, absolute paths, executable types and external action fields', () => {
    const f = fixture();
    for (const filename of ['../escape.txt', '/etc/escape.txt', 'a/b.txt', 'a\\b.txt', '%2e%2e.txt', '..txt', 'run.js', 'page.html']) expect(() => f.write({ filename, content: 'escape' })).toThrow();
    expect(() => f.write({ filename: 'ok.txt', content: 'ok', url: 'https://example.com' })).toThrow();
  });
  it('refuses a symlink directory, symlink target, hardlink and replaced directory', () => {
    const f = fixture();
    writeFileSync(path.join(f.outside, 'bait.txt'), 'unchanged');
    symlinkSync(path.join(f.outside, 'bait.txt'), path.join(f.output, 'bait.txt'));
    expect(() => f.write({ filename: 'bait.txt', content: 'bad' })).toThrow();
    expect(readFileSync(path.join(f.outside, 'bait.txt'), 'utf8')).toBe('unchanged');
    rmSync(path.join(f.output, 'bait.txt'));
    linkSync(path.join(f.outside, 'bait.txt'), path.join(f.output, 'bait.txt'));
    expect(() => f.write({ filename: 'next.txt', content: 'bad' })).toThrow();
    rmSync(path.join(f.output, 'bait.txt'));
    renameSync(f.output, `${f.output}-old`);
    symlinkSync(f.outside, f.output);
    expect(() => f.write({ filename: 'escape.txt', content: 'bad' })).toThrow();
    expect(() => createTeamOutputWriter({ directory: f.directory, exclusiveOutputOwnership: true })).toThrow();
    rmSync(f.output); mkdirSync(f.output);
    expect(() => f.write({ filename: 'replaced.txt', content: 'bad' })).toThrow();
  });
  it('refuses missing ownership, excessive output, file flood and aborted calls', () => {
    const f = fixture();
    expect(() => createTeamOutputWriter({ directory: f.directory, exclusiveOutputOwnership: false })).toThrow();
    expect(() => f.write({ filename: 'big.txt', content: 'é'.repeat(150000) })).toThrow('byte limit');
    expect(() => f.write({ filename: 'abort.txt', content: '' }, { signal: AbortSignal.abort() })).toThrow();
    for (let n = 0; n < 128; n++) writeFileSync(path.join(f.output, `${n}.txt`), '');
    expect(() => f.write({ filename: 'next.txt', content: 'bad' })).toThrow('count limit');
  });
});

describe('receipt-scoped actual output reads', () => {
  const readerFixture = () => {
    const f = fixture();
    const written = f.write({ filename: 'draft.md', content: 'Actual emitted draft. é' });
    const receipt = { path: written.path, sha256: written.sha256, sizeBytes: written.bytes, verified: true };
    return { ...f, receipt, read: createTeamOutputReader({ directory: f.directory, exclusiveOutputOwnership: true }) };
  };
  it('independently reads exact emitted bytes only with a trusted verified receipt', () => {
    const f = readerFixture();
    expect(f.read({ filename: 'draft.md' }, { receipt: f.receipt })).toMatchObject({ content: 'Actual emitted draft. é', sha256: f.receipt.sha256 });
    for (const receipt of [undefined, { ...f.receipt, verified: false }, { ...f.receipt, path: path.join(f.outside, 'draft.md') }, { ...f.receipt, sizeBytes: 262145 }]) {
      expect(() => f.read({ filename: 'draft.md' }, { receipt })).toThrow();
    }
    for (const filename of ['.', '../draft.md', '/etc/passwd', '.env', 'config.json/../draft.md', 'team-output/draft.md']) {
      expect(() => f.read({ filename }, { receipt: f.receipt })).toThrow();
    }
    expect(() => f.read({ filename: 'draft.md', receipt: f.receipt }, { receipt: f.receipt })).toThrow();
    expect(() => f.read({ filename: 'draft.md' }, { receipt: f.receipt, signal: AbortSignal.abort() })).toThrow();
  });
  it('refuses altered bytes, symlinks, hardlinks and replaced output directories', () => {
    const f = readerFixture();
    writeFileSync(f.receipt.path, 'x'.repeat(f.receipt.sizeBytes));
    expect(() => f.read({ filename: 'draft.md' }, { receipt: f.receipt })).toThrow('changed');
    rmSync(f.receipt.path);
    writeFileSync(path.join(f.outside, 'secret.md'), 'Actual emitted draft. é');
    symlinkSync(path.join(f.outside, 'secret.md'), f.receipt.path);
    expect(() => f.read({ filename: 'draft.md' }, { receipt: f.receipt })).toThrow();
    rmSync(f.receipt.path);
    linkSync(path.join(f.outside, 'secret.md'), f.receipt.path);
    expect(() => f.read({ filename: 'draft.md' }, { receipt: f.receipt })).toThrow('Unsafe');
    renameSync(f.output, `${f.output}-old`); mkdirSync(f.output);
    expect(() => f.read({ filename: 'draft.md' }, { receipt: f.receipt })).toThrow('scope');
    expect(() => createTeamOutputReader({ directory: f.directory, exclusiveOutputOwnership: false })).toThrow();
  });
});

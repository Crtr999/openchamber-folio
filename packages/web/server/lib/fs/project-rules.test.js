import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { createProjectRulesService } from './project-rules.js';
const fixture = async (test) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-project-rules-'));
  try { await test(directory, createProjectRulesService()); } finally { await fs.rm(directory, { recursive: true, force: true }); }
};
const save = (snapshot, kind, content, settings = snapshot.settings) => ({ kind, content, settings, expectedRevision: snapshot.revision });
describe('project rules saves', () => {
  it('saves local instructions, detects outside edits, and restores the previous version', () => fixture(async (directory, service) => {
    const file = path.join(directory, 'AGENTS.md');
    await fs.writeFile(file, 'original');
    const first = await service.load(directory, 'instructions');
    const second = await service.save(directory, save(first, 'instructions', 'edited'));
    expect(await fs.readFile(file, 'utf8')).toBe('edited'); expect(second.previous).toBe(true);
    await service.save(directory, { ...save(second, 'instructions', ''), restore: true });
    expect(await fs.readFile(file, 'utf8')).toBe('original');
    const latest = await service.load(directory, 'instructions');
    await fs.writeFile(file, 'outside');
    expect(await service.save(directory, save(latest, 'instructions', 'draft'))).toEqual({ conflict: true });
    expect(await fs.readFile(file, 'utf8')).toBe('outside');
  }));
  it('keeps JSONC comments, credentials and unrelated policies without returning credentials', () => fixture(async (directory, service) => {
    const file = path.join(directory, 'opencode.jsonc');
    await fs.writeFile(file, `{// retained comment
"provider":{"p":{"options":{"apiKey":"private-value"}}},"experimental":{"subagent_depth":3,"policies":[{"action":"tool.use","resource":"shell","effect":"deny"},{"action":"provider.use","resource":"old","effect":"deny"}]},"unknown":42}`);
    const first = await service.load(directory, 'configuration');
    expect(JSON.stringify(first)).not.toContain('private-value');
    await service.save(directory, save(first, 'configuration', '', { model: 'p/model', share: 'disabled', policies: [{ resource: '*', effect: 'deny' }, { resource: 'p', effect: 'allow' }] }));
    const written = await fs.readFile(file, 'utf8');
    expect(written).toContain('// retained comment');
    const config = parse(written);
    expect(config.provider.p.options.apiKey).toBe('private-value'); expect(config.unknown).toBe(42);
    expect(config.experimental.subagent_depth).toBe(3); expect(config.experimental.policies[0].action).toBe('tool.use');
  }));
  it('rejects malformed config and symlink targets without touching files', () => fixture(async (directory, service) => {
    await fs.writeFile(path.join(directory, 'opencode.json'), '{broken');
    await expect(service.load(directory, 'configuration')).rejects.toThrow();
    await fs.writeFile(path.join(directory, 'target.md'), 'untouched');
    await fs.symlink(path.join(directory, 'target.md'), path.join(directory, 'AGENTS.md'));
    await expect(service.load(directory, 'instructions')).rejects.toThrow();
    expect(await fs.readFile(path.join(directory, 'target.md'), 'utf8')).toBe('untouched');
  }));
  it('serializes simultaneous saves and creates missing files under the project', () => fixture(async (directory, service) => {
    const first = await service.load(directory, 'instructions');
    const results = await Promise.all([service.save(directory, save(first, 'instructions', 'one')), service.save(directory, save(first, 'instructions', 'two'))]);
    expect(results.filter(result => result.conflict)).toHaveLength(1);
    const config = await service.load(directory, 'configuration');
    expect(config.path).toBe(path.join(await fs.realpath(directory), '.opencode/opencode.json'));
    await service.save(directory, save(config, 'configuration', '', { ...config.settings, share: 'disabled' }));
    expect(parse(await fs.readFile(config.path, 'utf8')).share).toBe('disabled');
  }));
});

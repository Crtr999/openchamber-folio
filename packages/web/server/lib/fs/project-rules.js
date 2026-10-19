import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse, modify, applyEdits } from 'jsonc-parser';
import { z } from 'zod';

const kindSchema = z.enum(['instructions', 'memory', 'configuration']);
const permissionRuleSchema = z.object({
  action: z.string().min(1).max(200),
  resource: z.string().min(1).max(500),
  effect: z.enum(['allow', 'ask', 'deny']),
});
const settingsSchema = z.object({
  model: z.string().max(500),
  defaultAgent: z.string().max(200).optional(),
  share: z.enum(['inherit', 'manual', 'auto', 'disabled']),
  policies: z.array(z.object({ resource: z.string().min(1).max(500), effect: z.enum(['allow', 'deny']) })).max(100),
  permissions: z.array(permissionRuleSchema).max(200).optional(),
});
const saveSchema = z.object({ kind: kindSchema, expectedRevision: z.string(), content: z.string().max(1024 * 1024), settings: settingsSchema, restore: z.boolean().optional() });
const configSchema = z.object({
  model: z.union([z.string(), z.object({ providerID: z.string(), model: z.string() }).transform(value => `${value.providerID}/${value.model}`)]).optional(),
  default_agent: z.string().optional(),
  share: z.enum(['manual', 'auto', 'disabled']).optional(),
  permissions: z.array(z.object({ action: z.string(), resource: z.string(), effect: z.enum(['allow', 'ask', 'deny']) }).passthrough()).optional(),
  experimental: z.object({ policies: z.array(z.object({ action: z.string(), resource: z.string(), effect: z.enum(['allow', 'deny']) }).passthrough()).optional() }).passthrough().optional(),
}).passthrough();
const absent = (error) => error?.code === 'ENOENT';
const read = async (file) => { try { return await fs.readFile(file, 'utf8'); } catch (error) { if (absent(error)) return null; throw error; } };
const revision = (text) => createHash('sha256').update(text === null ? 'missing' : `present:${text}`).digest('hex');
const decode = (text) => {
  const errors = [];
  const value = parse(text ?? '{}', errors, { allowTrailingComma: true });
  if (errors.length && !(value === undefined && errors.every(error => error.error === 4))) throw new Error('Invalid configuration');
  return configSchema.parse(value ?? {});
};
const safeFile = async (directory, relative) => {
  const segments = relative.split('/');
  let current = directory;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Rules paths cannot be symlinks');
      if (current === path.join(directory, ...segments) && !stat.isFile()) throw new Error('Rules targets must be regular files');
    }
    catch (error) { if (!absent(error)) throw error; }
  }
  return current;
};
const target = async (directory, kind) => {
  if (kind === 'instructions') return safeFile(directory, 'AGENTS.md');
  if (kind === 'memory') return safeFile(directory, 'MEMORY.md');
  for (const candidate of ['.opencode/opencode.jsonc', '.opencode/opencode.json', 'opencode.jsonc', 'opencode.json']) {
    const file = await safeFile(directory, candidate);
    if (await read(file) !== null) return file;
  }
  return safeFile(directory, '.opencode/opencode.json');
};
const snapshot = async (file, kind) => {
  const text = await read(file);
  const config = kind === 'configuration' ? decode(text) : {};
  const model = config.model;
  return {
    path: file,
    revision: revision(text),
    content: (kind === 'instructions' || kind === 'memory') ? text ?? '' : '',
    previous: await read(`${file}.openchamber-previous`) !== null,
    settings: {
      model: model ?? '',
      defaultAgent: config.default_agent ?? '',
      share: config.share ?? 'inherit',
      policies: (config.experimental?.policies ?? []).filter(policy => policy.action === 'provider.use').map(({ resource, effect }) => ({ resource, effect })),
      permissions: (config.permissions ?? []).map(({ action, resource, effect }) => ({ action, resource, effect })),
    },
  };
};
const atomicWrite = async (file, content, privateBackup = false) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const mode = privateBackup ? 0o600 : await fs.stat(file).then(stat => stat.mode & 0o777).catch(error => { if (absent(error)) return 0o600; throw error; });
  const temporary = `${file}.tmp-${randomUUID()}`;
  try { await fs.writeFile(temporary, content, { mode, flag: 'wx' }); await fs.rename(temporary, file); }
  finally { await fs.unlink(temporary).catch(error => { if (!absent(error)) throw error; }); }
};
const queues = new Map();
const serialize = async (file, operation) => {
  const previous = queues.get(file) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(operation);
  queues.set(file, pending);
  try { return await pending; } finally { if (queues.get(file) === pending) queues.delete(file); }
};

/** Only local instructions, memory, and public configuration controls; inherited documents are never rewritten. */
export function createProjectRulesService() {
  return {
    async load(directory, kind) {
      const canonical = await fs.realpath(directory);
      const file = await target(canonical, kindSchema.parse(kind));
      await safeFile(canonical, path.relative(canonical, `${file}.openchamber-previous`));
      return snapshot(file, kind);
    },
    async save(directory, input) {
      const request = saveSchema.parse(input);
      const canonical = await fs.realpath(directory);
      const file = await target(canonical, request.kind);
      return serialize(file, async () => {
        await safeFile(canonical, path.relative(canonical, file));
        const backup = await safeFile(canonical, path.relative(canonical, `${file}.openchamber-previous`));
        const existing = await read(file);
        if (revision(existing) !== request.expectedRevision) return { conflict: true };
        let content = request.content;
        if (request.restore) { content = await read(backup); if (content === null) throw new Error('No previous version'); }
        else if (request.kind === 'configuration') {
          const config = decode(existing);
          content = existing ?? '{}\n';
          const update = (key, value) => { content = applyEdits(content, modify(content, key, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } })); };
          update(['model'], request.settings.model.trim() || undefined);
          if (request.settings.defaultAgent !== undefined) {
            update(['default_agent'], request.settings.defaultAgent.trim() || undefined);
          }
          update(['share'], request.settings.share === 'inherit' ? undefined : request.settings.share);
          const policies = [...(config.experimental?.policies ?? []).filter(policy => policy.action !== 'provider.use'), ...request.settings.policies.map(policy => ({ action: 'provider.use', ...policy }))];
          if (policies.length || config.experimental?.policies) update(['experimental', 'policies'], policies);
          if (request.settings.permissions !== undefined) {
            update(['permissions'], request.settings.permissions.length ? request.settings.permissions : undefined);
          }
          decode(content);
        }
        if (content !== existing) {
          if (existing !== null) await atomicWrite(backup, existing, true);
          // Repeat immediately before commit; never silently overwrite an externally changed draft.
          if (revision(await read(file)) !== request.expectedRevision) return { conflict: true };
          await atomicWrite(file, content);
        }
        return snapshot(file, request.kind);
      });
    },
  };
}

export function registerProjectRulesRoutes(app, resolveProjectDirectory) {
  const service = createProjectRulesService();
  const handler = (save) => async (req, res) => {
    try {
      const scope = await resolveProjectDirectory(req);
      if (!scope.directory) return res.status(400).json({ error: 'Active workspace is required' });
      const result = save ? await service.save(scope.directory, req.body) : await service.load(scope.directory, req.query.kind);
      if (result.conflict) return res.status(409).json({ error: 'Rules changed outside this editor' });
      return res.json(result);
    } catch { return res.status(400).json({ error: 'Could not read or save project rules' }); }
  };
  app.get('/api/fs/project-rules', handler(false));
  app.post('/api/fs/project-rules', handler(true));
}

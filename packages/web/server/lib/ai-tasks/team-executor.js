import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { createAiTaskExecutor, AiTaskSetupError } from './executor.js';
import { getSmallModelClient } from '../small-model/client.js';
import { teamPolicySchema, approvedTeamModels, discoverCatalogFreeModels, validateFreeModel, sameTeamModel, permissionEffect, validateCapabilityProfile,
  capabilityRules, confinementRules, validateOutputDirectory, verifyTeamArtifact } from './team-policy.js';

const ruleSchema = z.object({ action: z.string(), resource: z.string(), effect: z.enum(['allow', 'ask', 'deny']) });
const agentSchema = z.object({ id: z.string(), mode: z.enum(['primary', 'subagent', 'all']), hidden: z.boolean(), steps: z.number().int().positive().optional(),
  permissions: z.array(ruleSchema), model: z.object({ providerID: z.string(), id: z.string(), variant: z.string().optional() }).optional() });
const catalogSchema = z.object({ data: z.array(agentSchema) });
const instructionCatalogSchema = z.object({ data: z.array(z.object({ id: z.string(), system: z.string().optional(), description: z.string().optional() })) });
const policyRule = z.object({ action: z.enum(['provider.use', 'permission']), resource: z.string(), effect: z.enum(['allow', 'deny']) });
const configsSchema = z.array(z.object({ type: z.string(), info: z.object({ experimental: z.object({ policies: z.array(policyRule).default([]) }).optional() }).optional() }));
const tokensSchema = z.object({ input: z.number().nonnegative(), output: z.number().nonnegative(), reasoning: z.number().nonnegative(), cache: z.object({ read: z.number().nonnegative(), write: z.number().nonnegative() }) });
const sessionSchema = z.object({ id: z.string(), parentID: z.string().optional(), agent: z.string().optional(), model: z.object({ providerID: z.string(), id: z.string(), variant: z.string().optional() }).optional(),
  location: z.object({ directory: z.string() }), tokens: tokensSchema, cost: z.number().nonnegative(), metadata: z.record(z.string(), z.unknown()).optional() });
const match = (pattern, value) => new RegExp(`^${pattern.split('*').map((part) => part.split('?').map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.')).join('.*')}$`).test(value);
const effect = (rules, action, resource) => rules.filter((rule) => match(rule.action, action) && match(rule.resource, resource)).at(-1)?.effect ?? 'ask';
const scopedReadActions = ['read', 'glob', 'grep'];
const bounded = (agent) => agent.steps && agent.steps <= 20;
const options = () => ({ signal: AbortSignal.timeout(30_000) });

/** Uses only the app-managed, directory-scoped client injected by server startup. */
export function createTeamExecutor({ readProjects, waitForReady, getClient = getSmallModelClient, verifyFreeExecution, verifyTeamTool }) {
  const base = createAiTaskExecutor({ readProjects, waitForReady, getClient });
  const clientFor = (directory) => {
    const client = getClient(directory);
    if (!client) throw new AiTaskSetupError('runtime');
    return client;
  };
  const readPolicy = async (projectId) => {
    const projects = z.array(z.object({ id: z.string(), path: z.string() })).parse(await readProjects());
    const project = projects.find((item) => item.id === projectId);
    if (!project) throw new AiTaskSetupError('project');
    let directory;
    try { directory = await realpath(project.path); }
    catch { throw new AiTaskSetupError('directory'); }
    if (directory !== project.path) throw new AiTaskSetupError('teamPolicy');
    try {
      const policyFile = path.join(directory, '.openchamber/team-policy.json');
      if (await realpath(policyFile) !== policyFile) throw new AiTaskSetupError('teamPolicy');
      return { directory, policy: teamPolicySchema.parse(JSON.parse(await readFile(policyFile, 'utf8'))) };
    }
    catch { throw new AiTaskSetupError('teamPolicy'); }
  };
  // `requested` is a task's own model choice. It never changes project defaults
  // and must be one of the policy's reviewed zero-priced team models.
  const resolveProject = async (projectId, requested) => {
    const { directory, policy } = await readPolicy(projectId);
    const chosen = policy.version === 2
      ? requested
        ? (approvedTeamModels(policy).find((item) => sameTeamModel(requested, item))
          ?? (policy.freeOnly && requested.providerID === 'opencode' && requested.id ? { providerID: requested.providerID, id: requested.id } : undefined))
        : policy.model
      : null;
    if (policy.version === 2 && !chosen) throw new AiTaskSetupError('teamProvider');
    // Override only this resolver's read snapshot. Never save defaults or carry
    // the ordinary project's variant onto the explicitly selected team model.
    const resolver = policy.version === 2 ? createAiTaskExecutor({ waitForReady, getClient, readProjects: async () =>
      (await readProjects()).map((item) => item.id === projectId ? { ...item, defaultModel: `${chosen.providerID}/${chosen.id}`, defaultVariant: null } : item) }) : base;
    const destination = await resolver.resolveProject(projectId);
    if (destination.directory !== directory) throw new AiTaskSetupError('teamScope');
    if (requested && !sameTeamModel(destination.model, requested)) throw new AiTaskSetupError('teamProvider');
    if (policy.version === 1 && !policy.providers.includes(destination.model.providerID)
      || policy.version === 2 && !sameTeamModel(destination.model, chosen)) throw new AiTaskSetupError('teamProvider');
    const client = clientFor(directory);
    const selected = policy.version === 2 ? validateFreeModel(await client.model.list(undefined, options()), chosen) : null;
    const listedAgents = await client.agent.list(undefined, options());
    const agents = catalogSchema.parse(listedAgents).data;
    const manager = agents.find((agent) => agent.id === policy.manager && !agent.hidden && agent.mode !== 'subagent');
    if (!manager || !bounded(manager)) throw new AiTaskSetupError('teamManager');
    const configs = configsSchema.parse(await client.config.get(undefined, options()));
    const policies = configs.flatMap((entry) => entry.info?.experimental?.policies ?? []);
    const providers = policies.filter((rule) => rule.action === 'provider.use');
    // Conservative proof, not an imitation of OpenCode's authority-order evaluator.
    if (policy.version === 1 && (!providers.some((rule) => rule.resource === '*' && rule.effect === 'deny')
      || providers.some((rule) => rule.effect === 'allow' && !policy.providers.includes(rule.resource)))) throw new AiTaskSetupError('teamProvider');
    const profiles = policy.version === 1 ? policy.specialists.map((id) => ({ id })) : policy.specialists;
    const auxiliaryAgents = policy.version === 2 ? agents.filter((agent) => ['title', 'summary', 'compaction'].includes(agent.id)) : [];
    if (policy.version === 2) {
      const plugins = z.object({ data: z.array(z.object({ id: z.string().optional(), features: z.object({ server: z.boolean().optional() }),
        state: z.object({ status: z.enum(['active', 'failed']) }) })) }).safeParse(await client.plugin.list(undefined, options()));
      const guards = plugins.success ? plugins.data.data.filter((plugin) => plugin.id === 'open-carter-free-team-guard') : [];
      if (guards.length !== 1 || guards[0].state.status !== 'active' || guards[0].features.server !== true) throw new AiTaskSetupError('teamProvider');
      // Session transport hooks refuse auxiliary and fallback model changes.
      // Do not rewrite built-in title/compaction defaults for ordinary chats.
      if (!validateCapabilityProfile(manager, ['read-project'], chosen, profiles.map((item) => item.id))) throw new AiTaskSetupError('teamManager');
      if (profiles.some((item) => item.capabilities.includes('draft-output') || item.capabilities.includes('read-output'))) await validateOutputDirectory(directory);
      for (const [capability, tool] of [['safe-compute', 'team_compute'], ['draft-output', 'team_output'], ['read-output', 'team_read_output']]) {
        if (profiles.some((item) => item.capabilities.includes(capability))
            && (!plugins.success || plugins.data.data.filter(plugin => plugin.id === 'openchamber-team-tools' && plugin.state.status === 'active' && plugin.features.server === true).length !== 1
             || !verifyTeamTool || await verifyTeamTool({ directory, projectId, tool, version: 1 }) !== true)) throw new AiTaskSetupError('teamChild');
      }
    }
    const specialists = [];
    const childPermissions = [];
    for (const profile of profiles) {
      const { id } = profile;
      const child = agents.find((agent) => agent.id === id && !agent.hidden && agent.mode !== 'primary');
      const reset = child?.permissions.findLastIndex((rule) => rule.action === '*' && rule.resource === '*' && rule.effect === 'deny') ?? -1;
      const childRules = child?.permissions.slice(reset + 1) ?? [];
      const safe = policy.version === 2
        ? child && validateCapabilityProfile(child, profile.capabilities, chosen) && permissionEffect(manager.permissions, 'subagent', id) !== 'deny'
        : child && bounded(child) && (!child.model || child.model.providerID === destination.model.providerID && child.model.id === destination.model.id)
        && effect(manager.permissions, 'subagent', id) !== 'deny'
        && reset >= 0
        && effect(child.permissions, 'external_directory', '*') === 'deny'
        && childRules.every((rule) => rule.effect === 'deny' || scopedReadActions.includes(rule.action) && rule.resource === `${directory}/**`);
      if (!safe) throw new AiTaskSetupError('teamChild');
      specialists.push(id);
      if (policy.version === 2) childPermissions.push({ id, permissions: [
        { action: '*', resource: '*', effect: 'deny' }, ...capabilityRules(profile.capabilities).map(rule =>
          ['team_compute', 'team_output', 'team_read_output'].includes(rule.action) && permissionEffect(child.permissions, rule.action, rule.resource) === 'allow'
            ? { ...rule, effect: 'allow' } : rule),
        ...child.permissions.filter((rule) => rule.effect === 'deny' && !(rule.action === '*' && rule.resource === '*')),
        ...confinementRules,
      ] });
    }
    const rules = [
      { action: '*', resource: '*', effect: 'deny' },
      ...(policy.version === 2 ? capabilityRules(['read-project']) : scopedReadActions.map((action) => ({ action, resource: `${directory}/**`, effect: 'ask' }))),
      ...manager.permissions.filter((rule) => rule.effect === 'deny' && !(rule.action === '*' && rule.resource === '*')),
      ...specialists.map((id) => ({ action: 'subagent', resource: id,
        effect: policy.version === 2 && permissionEffect(manager.permissions, 'subagent', id) === 'allow' ? 'allow' : 'ask' })),
      ...(policy.version === 2 ? confinementRules : []),
      { action: 'external_directory', resource: '*', effect: 'deny' },
    ];
    if (policy.version === 2 && (!verifyFreeExecution || await verifyFreeExecution({ directory, model: policy.model, models: policy.models && approvedTeamModels(policy),
      manager: { id: manager.id, permissions: rules }, specialists: childPermissions }) !== true)) throw new AiTaskSetupError('teamProvider');
    const ruleFiles = [];
    for (const name of ['AGENTS.md', 'MEMORY.md']) {
      try {
        const file = path.join(directory, name);
        if (await realpath(file) !== file) throw new AiTaskSetupError('teamPolicy');
        ruleFiles.push(await readFile(file, 'utf8'));
      }
      catch (error) { if (error.code !== 'ENOENT') throw new AiTaskSetupError('teamPolicy'); ruleFiles.push(null); }
    }
    const policyRevision = createHash('sha256').update(JSON.stringify({ policy, policies, model: destination.model, selected, rules, childPermissions, agents: agents.filter((agent) => agent.id === manager.id || specialists.includes(agent.id) || auxiliaryAgents.includes(agent)), ruleFiles })).digest('hex');
    const queuePolicyRevision = createHash('sha256').update(JSON.stringify({ policyRevision, instructions: instructionCatalogSchema.parse(listedAgents).data.filter(agent => agent.id === manager.id || specialists.includes(agent.id)) })).digest('hex');
    return { ...destination, directory, permissions: rules, specialists, childPermissions, policyRevision, queuePolicyRevision, policyVersion: policy.version,
      teamModel: { providerID: destination.model.providerID, id: destination.model.id } };
  };
  const verifiedSession = async (run, id, parentID) => {
    const session = sessionSchema.parse(await clientFor(run.directory).session.get({ sessionID: id }, options()));
    if (session.id !== id || session.location.directory !== run.directory || session.parentID !== parentID) throw new AiTaskSetupError('teamScope');
    return session;
  };
  const children = async (run) => {
    const destination = await resolveProject(run.projectId, run.model);
    if (destination.directory !== run.directory) throw new AiTaskSetupError('teamScope');
    if (run.policyRevision && destination.policyRevision !== run.policyRevision) throw new AiTaskSetupError('teamPolicy');
    const parent = await verifiedSession(run, run.sessionId, undefined);
    const unlocked = Boolean(parent.metadata?.openchamber);
    if (parent.agent !== destination.agent || (!unlocked && (parent.model?.providerID !== destination.model.providerID || parent.model?.id !== destination.model.id))) throw new AiTaskSetupError('teamScope');
    const items = await base.children(run);
    const verified = [parent];
    for (const child of items) {
      const session = await verifiedSession(run, child.id, run.sessionId);
      verified.push(session);
      if (!destination.specialists.includes(session.agent) || session.model?.providerID !== destination.model.providerID || session.model?.id !== destination.model.id) throw new AiTaskSetupError('teamScope');
      if (destination.policyVersion === 2 && !sameTeamModel(session.model, destination.model)) throw new AiTaskSetupError('teamScope');
    }
    if (destination.policyVersion === 2 && ((!unlocked && !sameTeamModel(parent.model, destination.model)) || verified.some((session) => (session.id !== parent.id || !unlocked) && session.cost !== 0))) throw new AiTaskSetupError('teamProvider');
    return items;
  };
  const api = {
    resolveProject,
    async authorizeTool(run, input) {
      const latest = await resolveProject(run.projectId, run.model);
      if (latest.policyRevision !== run.policyRevision || latest.directory !== run.directory || latest.policyVersion !== 2) throw new AiTaskSetupError('teamPolicy');
      const parent = await verifiedSession(run, run.sessionId, undefined);
      const child = await verifiedSession(run, input.sessionID, run.sessionId);
      const profile = latest.childPermissions.find(item => item.id === child.agent);
      if (parent.agent !== latest.agent || !sameTeamModel(parent.model, latest.model) || !sameTeamModel(child.model, latest.model)
        || parent.cost !== 0 || child.cost !== 0 || !profile || permissionEffect(profile.permissions, input.action, '*') === 'deny') throw new AiTaskSetupError('teamScope');
      if (input.action !== 'team_read_output') return { directory: run.directory };
      // Only current-run, observed sessions and completed output-tool receipts
      // can authorize a read. Retained run.artifacts and caller receipts never do.
      const observed = await children(run);
      const evidence = await api.evidence(run);
      if (evidence.receiptScan.kind !== 'complete' || evidence.receiptScan.incompleteSessionIds.length) throw new AiTaskSetupError('teamScope');
      const ids = new Set([run.sessionId, ...observed.map(item => item.id)]);
      const filename = z.string().max(96).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*\.(?:txt|md|csv|json)$/).parse(input.input.filename);
      const target = path.join(run.directory, 'team-output', filename);
      const matches = evidence.outputReceipts.filter(item => item.path === target && ids.has(item.sessionId));
      if (matches.length !== 1) throw new AiTaskSetupError('teamScope');
      const artifact = matches[0];
      return { directory: run.directory, receipt: artifact };
    },
    async accounting(run) {
      const items = await base.children(run);
      const sessions = [await verifiedSession(run, run.sessionId, undefined)];
      for (const child of items) sessions.push(await verifiedSession(run, child.id, run.sessionId));
      return { kind: 'available', tokens: sessions.reduce((sum, session) => sum + session.tokens.input + session.tokens.output + session.tokens.reasoning + session.tokens.cache.read + session.tokens.cache.write, 0),
        reportedCost: sessions.reduce((sum, session) => sum + session.cost, 0), sessionIds: sessions.map(session => session.id), dollarCapSupported: false };
    },
    async create(input) {
      const latest = await resolveProject(input.destination.projectId, input.destination.teamModel);
      if (latest.policyRevision !== input.destination.policyRevision) throw new AiTaskSetupError('teamPolicy');
      const created = await base.create({ ...input, destination: latest });
      const session = await verifiedSession({ directory: latest.directory }, created.id, undefined);
      if (session.agent !== latest.agent || session.model?.providerID !== latest.model.providerID || session.model?.id !== latest.model.id
        || latest.policyVersion === 2 && (!sameTeamModel(session.model, latest.model) || session.cost !== 0)) throw new AiTaskSetupError('teamScope');
      return created;
    },
    async send(run, content) {
      const latest = await resolveProject(run.projectId, run.model);
      if (latest.policyRevision !== run.policyRevision) throw new AiTaskSetupError('teamPolicy');
      await children(run);
      await base.send(run, content);
    },
    children,
    async inspect(run) {
      const items = await children(run);
      const active = await clientFor(run.directory).session.active(options());
      if (items.some((child) => active[child.id])) return { kind: 'running' };
      // Review against the current authoritative children, not a retained list
      // that can omit a newly completed reviewer or retain an obsolete scope.
      return base.inspect({ ...run, children: items });
    },
    async evidence(run) {
      // Accounting is observational: a policy/pricing violation must not erase
      // the actual spend. Identity and directory checks still fail closed.
      const items = await base.children(run);
      const sessions = [await verifiedSession(run, run.sessionId, undefined)];
      for (const child of items) sessions.push(await verifiedSession(run, child.id, run.sessionId));
      const tokens = sessions.reduce((sum, session) => sum + session.tokens.input + session.tokens.output + session.tokens.reasoning + session.tokens.cache.read + session.tokens.cache.write, 0);
      const artifacts = [];
      const outputReceipts = [];
      const handoffs = [];
      const incompleteSessionIds = [];
      const messagesSchema = z.object({ data: z.array(z.object({ id: z.string(), type: z.string(), time: z.object({ completed: z.number().optional() }).optional(),
        content: z.array(z.union([
          z.object({ type: z.literal('tool'), id: z.string(), name: z.string(), state: z.object({ status: z.string(),
            content: z.array(z.union([z.object({ type: z.literal('text'), text: z.string() }), z.object({ type: z.string().refine(type => type !== 'text') })])).optional(),
          }) }),
          z.object({ type: z.string().refine((type) => type !== 'tool') }),
        ])).optional(),
        snapshot: z.object({ files: z.array(z.string()).optional() }).optional() })),
        cursor: z.object({ next: z.string().nullish() }).optional() });
      for (const session of sessions) {
        const messages = [];
        const cursors = new Set();
        const messageIds = new Set();
        let cursor;
        let complete = false;
        for (let pageIndex = 0; pageIndex < 8; pageIndex += 1) {
          let page;
          try {
            page = messagesSchema.parse(await clientFor(run.directory).message.list({ sessionID: session.id,
              ...(cursor ? { cursor } : { order: 'desc' }), limit: 100 }, options()));
          } catch { break; } // Retain verified receipts already observed; expose the incomplete scan.
          for (const message of page.data) {
            if (!messageIds.has(message.id)) { messages.push(message); messageIds.add(message.id); }
          }
          if (!page.cursor) break; // Missing pagination metadata is not proof of completeness.
          cursor = page.cursor.next;
          if (!cursor) { complete = true; break; }
          if (cursors.has(cursor)) break;
          cursors.add(cursor);
        }
        if (!complete) incompleteSessionIds.push(session.id);
        for (const message of messages.filter((item) => item.type === 'assistant')) {
          for (const tool of message.content ?? []) {
            if (tool.type === 'tool' && tool.name === 'team_output' && tool.state.status === 'completed') {
              const receiptSchema = z.object({ version: z.literal(1), path: z.string(), relativePath: z.string().regex(/^team-output\/[A-Za-z0-9][A-Za-z0-9_-]*\.(?:txt|md|csv|json)$/),
                bytes: z.number().int().nonnegative().max(262144), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
              for (const part of tool.state.content ?? []) {
                if (part.type !== 'text') continue;
                const receipt = receiptSchema.parse(JSON.parse(part.text));
                const artifact = await verifyTeamArtifact(run.directory, receipt.relativePath);
                if (artifact.path !== receipt.path || artifact.sha256 !== receipt.sha256 || artifact.sizeBytes !== receipt.bytes) throw new AiTaskSetupError('teamScope');
                const verified = { ...artifact, sessionId: session.id, messageId: message.id };
                artifacts.push(verified);
                outputReceipts.push(verified);
              }
            }
            if (session.id === run.sessionId && tool.type === 'tool' && tool.name === 'subagent' && tool.id && tool.state?.status === 'completed') {
              // Evidence of a real tool completion, not a prose-inferred child
              // link. The direct-child API independently proves child identity.
              handoffs.push({ sessionId: session.id, messageId: message.id, toolId: tool.id, status: 'completed' });
            }
          }
        }
        for (const message of messages.filter((item) => item.type === 'assistant' && item.time?.completed)) {
          for (const file of message.snapshot?.files ?? []) {
            artifacts.push({ ...await verifyTeamArtifact(run.directory, file), sessionId: session.id, messageId: message.id });
          }
        }
      }
      // Only durable OpenCode session counters are used, never prose or cost guesses.
      return { usage: { kind: 'available', tokens, reportedCost: sessions.reduce((sum, session) => sum + session.cost, 0), sessionIds: sessions.map((session) => session.id), dollarCapSupported: false }, artifacts, outputReceipts, handoffs,
        receiptScan: { kind: incompleteSessionIds.length ? 'partial' : 'complete', incompleteSessionIds } };
    },
    async pause(run) {
      // One deadline bounds the entire proof, including uncooperative reads.
      const controller = new AbortController();
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new AiTaskSetupError('teamPause')); }, 5_000);
      });
      const within = (work) => Promise.race([work, deadline]);
      try {
        const client = clientFor(run.directory);
        await within(verifiedSession(run, run.sessionId, undefined));
        // Stop further delegation before enumerating children. No policy check
        // may prevent interruption of already-authorized, scope-verified work.
        let failed = false;
        try { await within(client.session.interrupt({ sessionID: run.sessionId }, { signal: controller.signal })); }
        catch { failed = true; }
        const known = new Set();
        while (!controller.signal.aborted) {
          let items;
          try { items = await within(base.children(run)); }
          catch { failed = true; items = run.children ?? []; }
          if (!known.size) items = [...items, ...(run.children ?? [])];
          let discovered = false;
          for (const child of items) {
            if (known.has(child.id)) continue;
            discovered = true;
            try {
              await within(verifiedSession(run, child.id, run.sessionId));
              await within(client.session.interrupt({ sessionID: child.id }, { signal: controller.signal }));
              known.add(child.id);
            } catch { failed = true; }
          }
          // Re-enumerate after interrupts before accepting the inactive snapshot.
          if (discovered && !failed) continue;
          if (failed) throw new AiTaskSetupError('teamPause');
          await within(verifiedSession(run, run.sessionId, undefined));
          for (const id of known) await within(verifiedSession(run, id, run.sessionId));
          const active = z.record(z.string(), z.object({ type: z.string() })).parse(
            await within(client.session.active({ signal: controller.signal })));
          if (![run.sessionId, ...known].some(id => Object.hasOwn(active, id))) return;
          await within(new Promise(resolve => setTimeout(resolve, 100)));
        }
        throw new AiTaskSetupError('teamPause');
      } catch { throw new AiTaskSetupError('teamPause'); }
      finally { clearTimeout(timer); controller.abort(); }
    },
    /** Reviewed team models that currently price at zero, for a task's model choice. */
    async models(projectId) {
      let read;
      try { read = await readPolicy(projectId); }
      catch { return []; }
      if (read.policy.version !== 2) return [];
      await waitForReady?.();
      const catalog = await clientFor(read.directory).model.list(undefined, options());
      return discoverCatalogFreeModels(catalog, read.policy).flatMap((item) => {
        try {
          validateFreeModel(catalog, item);
          const name = catalog.data.find((entry) => sameTeamModel(entry, item))?.name;
          return [{ providerID: item.providerID, id: item.id, name: typeof name === 'string' ? name : item.id, default: sameTeamModel(item, read.policy.model), ...(item.billing ? { billing: item.billing } : {}) }];
        } catch { return []; }
      });
    },
    async diagnose(projectId) {
      const projects = z.array(z.object({ id: z.string(), path: z.string() })).parse(await readProjects());
      const project = projects.find((item) => item.id === projectId);
      if (!project) throw new AiTaskSetupError('project');
      await waitForReady?.();
      const agents = catalogSchema.parse(await clientFor(project.path).agent.list(undefined, options())).data;
      let validation;
      try {
        const destination = await resolveProject(projectId);
        validation = { kind: 'ready', policyRevision: destination.policyRevision, specialists: destination.specialists };
      } catch (error) {
        validation = { kind: 'blocked', code: error instanceof AiTaskSetupError ? error.code : 'unavailable', message: error instanceof AiTaskSetupError ? error.message : 'Project policy could not be verified.' };
      }
      return { projectId, directory: project.path, agents: agents.map(({ id, mode, hidden, steps, model }) => ({ id, mode, hidden, steps, model })), validation };
    },
  };
  return api;
}

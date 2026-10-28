import express from 'express';
import { z } from 'zod';
import { PERSONAL_AWARENESS_ID } from './personal-awareness.js';

const sources = z.array(z.enum(['past-chats', 'follow-ups', 'notion', 'calendar', 'outlook'])).min(1).max(5);
const inputSchema = z.object({
  approved: z.literal(true), projectId: z.string().min(1), providerID: z.literal('openai'),
  modelID: z.string().min(1).max(200), sources,
  mailAccounts: z.array(z.string().email()).max(5),
}).strict();
const nativeSchema = z.object({ notion: z.boolean(), calendar: z.boolean(), mailAccounts: z.array(z.string().email()).max(55) });
const modelsSchema = z.object({ data: z.array(z.object({ id: z.string(), providerID: z.string(), name: z.string().optional(), enabled: z.boolean().optional() })) });

// Consent is independent of credentials. Listing choices never reads source
// bodies or establishes a connection, and a failed enrollment stays disabled.
export function registerAwarenessEnrollment(app, { store, guard, scheduledTaskService, getClient, resolveAllowedProviders, readConnections, isBlocked, now = Date.now }) {
  let queue = Promise.resolve();
  const serial = (work) => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  const permitted = async (directory) => {
    if (!(await guard.check(directory)).ok) return false;
    const providers = await resolveAllowedProviders(directory);
    return Array.isArray(providers) && providers.every((provider) => provider === 'openai');
  };
  const choices = async () => {
    const projects = [];
    for (const project of await scheduledTaskService.listProjects()) {
      if (!await permitted(project.path)) continue;
      const client = getClient(project.path);
      if (!client) throw new Error('OpenCode unavailable');
      const models = modelsSchema.parse(await client.model.list()).data
        .filter((model) => model.providerID === 'openai' && model.enabled !== false)
        .map((model) => ({ id: model.id, name: model.name || model.id }));
      if (models.length) projects.push({ id: project.id, name: project.label || project.name || project.path, models });
    }
    const connected = readConnections ? nativeSchema.parse(await readConnections()) : { notion: false, calendar: false, mailAccounts: [] };
    return { projects, connected };
  };
  const handle = (work) => async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try { return await work(req, res); }
    catch (error) {
      if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
      return next(error);
    }
  };
  const base = '/api/companion/personal-awareness';
  app.get(base, handle(async (_req, res) => {
    if (isBlocked()) return res.status(403).json({ code: 'enterprise_mode', error: 'Personal review is disabled by enterprise policy.' });
    const available = await choices();
    const state = await store.read();
    const consent = state.awareness;
    // Do not reveal an older approval for a folder which is now excluded.
    const visible = consent && available.projects.some((project) => project.id === consent.projectId);
    return res.json({ ...available, approval: visible ? {
      enabled: consent.enabled === true && state.settings.enabled, projectId: consent.projectId, modelID: consent.modelID,
      sources: consent.sources ?? [], mailAccounts: consent.mailAccounts ?? [],
    } : null });
  }));
  app.put(base, express.json({ limit: '8kb' }), handle(async (req, res) => {
    const parsed = inputSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Explicit folder, model and source approval is required.' });
    return serial(async () => {
      if (isBlocked()) return res.status(403).json({ code: 'enterprise_mode', error: 'Personal review is disabled by enterprise policy.' });
      const input = parsed.data;
      const available = await choices();
      const project = available.projects.find((item) => item.id === input.projectId);
      if (!project || !project.models.some((model) => model.id === input.modelID)) return res.status(400).json({ error: 'Select an available OpenAI model and permitted folder.' });
      const selected = new Set(input.sources);
      if ((selected.has('notion') && !available.connected.notion) || (selected.has('calendar') && !available.connected.calendar)
        || (selected.has('outlook') && (!input.mailAccounts.length || input.mailAccounts.some((address) => !available.connected.mailAccounts.includes(address))))
        || (!selected.has('outlook') && input.mailAccounts.length)) return res.status(400).json({ error: 'Connect each selected source before approving review.' });
      const prior = (await store.read()).awareness;
      const previousTask = (await scheduledTaskService.list(input.projectId)).find((task) => task.id === PERSONAL_AWARENESS_ID);
      // Disable first, so old consent cannot execute a replacement schedule.
      await store.update((state) => ({ ...state, awareness: { ...state.awareness, enabled: false } }));
      const priorProject = (await scheduledTaskService.listProjects()).find((item) => item.id === prior?.projectId);
      if (priorProject && prior.projectId !== input.projectId && await permitted(priorProject.path)) {
        const old = (await scheduledTaskService.list(prior.projectId)).find((task) => task.id === PERSONAL_AWARENESS_ID);
        if (old) await scheduledTaskService.upsert(prior.projectId, { ...old, enabled: false });
      }
      const state = await store.read();
      if (!state.settings.enabled) return res.status(409).json({ error: 'Personal follow-ups are disabled.' });
      try {
        await scheduledTaskService.upsert(input.projectId, {
          id: PERSONAL_AWARENESS_ID, name: 'Approved personal review', enabled: true,
          schedule: { kind: 'daily', times: ['09:00'], timezone: state.settings.timezone },
          execution: { providerID: 'openai', modelID: input.modelID, permissionAutoAccept: false,
            goalEnabled: true, goalTokenBudget: 10000, prompt: 'Review only the separately approved personal evidence supplied by the server. Follow its read-only limits and return [CARTER_NO_UPDATE] when nothing useful changed.' },
        });
        await store.update((current) => ({ ...current, awareness: {
          enabled: true, approvedAt: Math.max(now(), (prior?.approvedAt ?? 0) + 1), projectId: input.projectId, providerID: 'openai', modelID: input.modelID,
          sources: [...selected], mailAccounts: input.mailAccounts, reviewed: [], health: [], notionOffset: 0,
        } }));
      } catch (error) {
        // Consent remains disabled even if schedule cleanup fails.
        try {
          if (previousTask) await scheduledTaskService.upsert(input.projectId, { ...previousTask, enabled: false });
          else await scheduledTaskService.remove(input.projectId, PERSONAL_AWARENESS_ID);
        }
        catch { throw new AggregateError([error], 'Approval failed; inactive schedule cleanup also failed.'); }
        throw error;
      }
      return res.json({ enabled: true });
    });
  }));
  app.delete(base, handle(async (_req, res) => serial(async () => {
    const previous = (await store.read()).awareness;
    await store.update((state) => ({ ...state, awareness: { ...state.awareness, enabled: false, pending: undefined } }));
    const project = (await scheduledTaskService.listProjects()).find((item) => item.id === previous?.projectId);
    if (project && await permitted(project.path)) {
      const task = (await scheduledTaskService.list(previous.projectId)).find((item) => item.id === PERSONAL_AWARENESS_ID);
      if (task) await scheduledTaskService.upsert(previous.projectId, { ...task, enabled: false });
    }
    return res.json({ enabled: false });
  })));
}

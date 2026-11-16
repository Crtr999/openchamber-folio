import { readFile, realpath, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { resolveNativeProviderBinding } from './binding.js';

const appSchema = z.enum(['calendar', 'reminders', 'notes', 'mail']);
const requestSchema = z.object({
  app: appSchema,
  containerId: z.string().min(1).max(1024),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  limit: z.number().int().min(1).max(100).default(50),
  requestedByUser: z.literal(true),
}).strict().refine((value) => {
  const span = Date.parse(value.end) - Date.parse(value.start);
  return span > 0 && span <= 31 * 86_400_000;
}, 'Read range must be positive and at most 31 days');
const grantsSchema = z.object({
  version: z.literal(1),
  grants: z.array(z.object({
    directory: z.string().min(1),
    providerID: z.string().min(1),
    providerBinding: z.string().regex(/^[a-f0-9]{64}$/),
    runtimeId: z.string().min(1),
    runtimeEndpoint: z.url(),
    app: appSchema,
    containerIds: z.array(z.string().min(1)).min(1).max(100),
  }).strict()).max(100),
}).strict();
const unavailable = { status: 'unsupported', reason: 'Native background reads require the local macOS desktop host.' };
const deny = () => {
  const error = new Error('Native app reads require a user-approved directory, provider and exact container grant.');
  error.statusCode = 403;
  throw error;
};

const approvalSchema = z.object({ app: z.enum(['calendar', 'reminders']), containerId: z.string().min(1).max(1024), requestedByUser: z.literal(true) });
const containersSchema = z.object({ app: z.enum(['calendar', 'reminders']), requestedByUser: z.literal(true) });
const decisionSchema = z.object({ decision: z.enum(['approved', 'revoked', 'cancelled', 'unavailable', 'busy']) }).strict();

/** Grants can change only after a trusted native user-confirmation callback. */
export function createNativeAppActions({ dataDir, readSession, getReader, getRuntimeIdentity = () => null, resolveBinding = resolveNativeProviderBinding }) {
  const grantPath = path.join(dataDir, 'native-app-read-grants.json');
  let changingGrant = false;
  const readGrants = async () => {
    try { return grantsSchema.parse(JSON.parse(await readFile(grantPath, 'utf8'))).grants; }
    catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  };
  const saveGrants = async (grants) => {
    if (!grantsSchema.safeParse({ version: 1, grants }).success) {
      const error = new Error('Native read grant state would be invalid. Revoke an existing scope before adding more grants.');
      error.statusCode = 409;
      throw error;
    }
    await mkdir(dataDir, { recursive: true });
    const temporary = `${grantPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, grants }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, grantPath);
    } finally { await rm(temporary, { force: true }); }
  };
  return {
    execute: async (action, input, contextDirectory, options = {}) => {
      if (action === 'native.status') return getReader()?.status() ?? unavailable;
      if (!['native.read', 'native.requestApproval', 'native.containers'].includes(action)) throw new Error('Unsupported native reader action');
      const reader = getReader();
      if (!reader) return unavailable;
      // Select fields rather than accepting caller-controlled directory/session scope.
      const parsed = action === 'native.containers'
        ? containersSchema.safeParse({ app: input.app, requestedByUser: input.requestedByUser })
        : action === 'native.requestApproval'
        ? approvalSchema.safeParse({ app: input.app, containerId: input.containerId, requestedByUser: input.requestedByUser })
        : requestSchema.safeParse({ app: input.app, containerId: input.containerId,
          start: input.start, end: input.end, limit: input.limit, requestedByUser: input.requestedByUser });
      if (!parsed.success) {
        const message = action === 'native.containers'
          ? 'Container discovery requires app calendar/reminders and requestedByUser: true.'
          : action === 'native.requestApproval'
            ? 'Native approval requires app calendar/reminders, an exact user-selected containerId and requestedByUser: true.'
            : 'Native reads require app, exact containerId, requestedByUser: true, limit 1-100 and a positive ISO datetime range of at most 31 days.';
        const error = new Error(message);
        error.statusCode = 400;
        throw error;
      }
      const request = parsed.data;
      if (request.app === 'notes' || request.app === 'mail') return { status: 'unsupported', app: request.app, reason: 'No scoped native read connector is installed for this app.' };
      if (!options.contextSessionId || !contextDirectory) deny();
      const session = await readSession(options.contextSessionId);
      const sessionPath = session?.location?.directory || session?.directory;
      if (!sessionPath || /zdr/i.test(session?.model?.providerID || '') || /zdr/i.test(session?.agent || '')) deny();
      const directory = await realpath(contextDirectory).catch(() => null);
      const sessionDirectory = await realpath(sessionPath).catch(() => null);
      if (!directory || directory !== sessionDirectory || /(?:^|[/\\])(?:legal|zdr)(?:[/\\]|$)/i.test(directory)) deny();
      const providerBinding = await resolveBinding(directory, session);
      const runtimeEndpoint = z.url().parse(await getRuntimeIdentity());
      const scope = { directory, providerID: session.model.providerID, providerBinding, runtimeId: reader.runtimeId, runtimeEndpoint, app: request.app, containerId: action === 'native.containers' ? 'metadata-only container listing' : request.containerId };
      const verifyCurrentScope = async () => {
        const currentSession = await readSession(options.contextSessionId);
        const currentPath = currentSession?.location?.directory || currentSession?.directory;
        if (!currentPath) deny();
        const currentDirectory = await realpath(currentPath).catch(() => null);
        if (currentDirectory !== directory || currentSession?.model?.providerID !== scope.providerID || /zdr/i.test(currentSession?.agent || '')
          || await resolveBinding(directory, currentSession) !== providerBinding || getReader()?.runtimeId !== scope.runtimeId
          || await getRuntimeIdentity() !== runtimeEndpoint || options.signal?.aborted) deny();
      };
      if (action !== 'native.read') {
        if (!reader.requestApproval || reader.status().status !== 'available') return unavailable;
        if (changingGrant) return { status: 'busy', reason: 'A native approval is already pending.' };
        changingGrant = true;
        try {
          // A corrupt grant file must not be silently replaced by a new approval.
          if (action === 'native.requestApproval') {
            try { await readGrants(); }
            catch {
              const error = new Error('Native read approval state is invalid. No grants were changed.');
              error.statusCode = 409;
              throw error;
            }
          }
          if (options.signal?.aborted) return { status: 'cancelled' };
          const { decision } = decisionSchema.parse(await reader.requestApproval({ ...scope, purpose: action === 'native.containers' ? 'containers' : 'grant' }));
          if (decision !== 'approved' && decision !== 'revoked') return { status: decision };
          await verifyCurrentScope();
          if (action === 'native.containers') {
            if (decision !== 'approved') return { status: 'cancelled' };
            const result = await reader.containers({ app: request.app }, options.signal);
            await verifyCurrentScope();
            return result;
          }
          const grants = await readGrants();
          const remaining = [];
          for (const grant of grants) {
            if (grant.directory !== directory || grant.providerID !== scope.providerID || grant.app !== scope.app) { remaining.push(grant); continue; }
            const containerIds = grant.containerIds.filter((id) => id !== scope.containerId);
            if (containerIds.length > 0) remaining.push({ ...grant, containerIds });
          }
          if (decision === 'approved') remaining.push({ directory, providerID: scope.providerID, providerBinding, runtimeId: scope.runtimeId, runtimeEndpoint, app: scope.app, containerIds: [scope.containerId] });
          await saveGrants(remaining);
          return { status: decision, scope };
        } finally { changingGrant = false; }
      }
      let grants;
      try { grants = await readGrants(); }
      catch { deny(); }
      let granted = false;
      for (const grant of grants) {
        if (grant.app !== request.app || grant.providerID !== scope.providerID || grant.providerBinding !== providerBinding || grant.runtimeId !== scope.runtimeId || grant.runtimeEndpoint !== runtimeEndpoint || !grant.containerIds.includes(request.containerId)) continue;
        if (await realpath(grant.directory).catch(() => null) === directory) granted = true;
      }
      if (!granted) deny();
      const { app, containerId, start, end, limit } = requestSchema.parse(request);
      const query = { app, containerId, start, end, limit };
      const result = await reader.read(query, options.signal);
      await verifyCurrentScope();
      return result;
    },
  };
}

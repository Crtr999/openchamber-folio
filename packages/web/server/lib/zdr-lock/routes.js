import express from 'express';
import { z } from 'zod';

const parseJsonBody = express.json({ limit: '4kb' });
const isZdrBound = (providers) => providers.some((provider) => /zdr/i.test(provider));
const stringsSchema = z.array(z.string());
const scopeSchema = z.string().min(1);
const scopes = (values) => values.flatMap((value) => {
  const parsed = scopeSchema.safeParse(value);
  return parsed.success ? [parsed.data] : [];
});

/**
 * `state` says whether a PIN is set and which folders it guards: every configured folder bound to
 * a zero-retention provider. The check itself stays on the server.
 */
export const registerZdrLockRoutes = (app, { lock, listProjectPaths, resolveAllowedProviders, path, privacy }) => {
  app.use('/api/openchamber/zdr-lock', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.get('/api/openchamber/zdr-lock/state', async (_req, res) => {
    const directories = [];
    try {
      const projects = await listProjectPaths();
      if (!Array.isArray(projects)) throw new Error('Project list unavailable');
      for (const item of projects) {
        const resolved = path.resolve(item);
        try {
          if (privacy) {
            if (!await privacy.allowsDirectory(resolved, { fresh: true })) directories.push(resolved);
            continue;
          }
          if (/zdr/i.test(resolved)) { directories.push(resolved); continue; }
          const providers = stringsSchema.parse(await resolveAllowedProviders(resolved));
          if (isZdrBound(providers)) directories.push(resolved);
        } catch { directories.push(resolved); }
      }
      if (privacy) {
        for (const directory of [...directories]) directories.push(await privacy.canonical(directory));
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({ pinSet: lock.isSet(), directories: [...new Set(directories)], retryAfterMs: lock.retryAfterMs(), unlocked: lock.isAuthorized(_req.get('x-openchamber-zdr-access')) });
    } catch { res.status(503).json({ error: 'Lock state unavailable' }); }
  });

  app.post('/api/openchamber/zdr-lock/verify', parseJsonBody, (req, res) => {
    const result = lock.verify(req.body?.pin);
    res.status(result.ok ? 200 : 403).json(result);
  });

  app.post('/api/openchamber/zdr-lock/set', parseJsonBody, (req, res) => {
    const result = lock.set(req.body?.pin, req.body?.currentPin);
    res.status(result.ok ? 200 : 403).json(result);
  });

  app.post('/api/openchamber/zdr-lock/clear', parseJsonBody, (req, res) => {
    const result = lock.clear(req.body?.pin);
    res.status(result.ok ? 200 : 403).json(result);
  });
  app.post('/api/openchamber/zdr-lock/lock', (_req, res) => {
    lock.revoke(_req.get('x-openchamber-zdr-access'));
    res.json({ ok: true });
  });
};

/** Directory-addressed API reads and mutations require a live server grant.
 * A grant is never a Home collection permission. Those routes use the permanent folder guard.
 */
export const registerZdrAccessGuard = (app, { lock, listProjects, folderGuard, resolveSessionDirectory, privacy, path }) => {
  app.use(['/api/session', '/api/message', '/api/part', '/api/permission', '/api/form', '/api/openchamber/sessions', '/api/openchamber/control'], (req, res, next) => {
    try {
      if (!lock.isSet() || lock.isAuthorized(req.get('x-openchamber-zdr-access'))) return next();
      // The generic proxy can reserialize a parsed JSON body. A new session
      // may name its location only here, not in the query/header.
      return express.json({ limit: '50mb' })(req, res, next);
    } catch { return res.status(503).json({ error: 'Lock state unavailable', code: 'zdr_lock_unavailable' }); }
  });
  app.use('/api', async (req, res, next) => {
    if (req.path.startsWith('/openchamber/zdr-lock/')) return next();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && /^\/(?:config|fs|projects)(?:\/|$)/.test(req.path)) {
      res.once('finish', () => privacy?.invalidate());
    }
    try {
      if (!lock.isSet() || lock.isAuthorized(req.get('x-openchamber-zdr-access'))) return next();
      const hints = scopes([req.query.directory, req.query['location[directory]'], req.query.path,
         req.get('x-opencode-directory'), req.body?.directory, req.body?.location?.directory, req.body?.path,
        req.body?.sourceDirectory, req.body?.targetDirectory, req.body?.parameters?.directory, req.body?.parameters?.path]);
      const sessionMatch = req.path.match(/^\/(?:session|sessions|openchamber\/sessions|message-queue\/sessions|goals\/objective)\/(ses_[^/]+)(?:\/|$)/);
      const sessionIDs = scopes([sessionMatch?.[1], req.query.sessionID, req.query.sessionId, req.body?.sessionID, req.body?.sessionId, req.body?.parameters?.sessionId,
        ...(Array.isArray(req.body?.sessionIds) ? req.body.sessionIds : [])]);
      for (const id of new Set(sessionIDs)) {
        // Scope hints are user input. The existing engine-owned session index
        // decides ownership, so a forged ordinary directory cannot bypass PIN.
        const directory = await resolveSessionDirectory?.(id);
        if (!directory) return res.status(403).json({ error: 'Session folder could not be verified.', code: 'zdr_locked' });
        hints.push(directory);
      }
      // Never let an omitted directory fall through to the engine's current
      // location for a session-addressed read or mutation.
      if (/^\/(?:session\/ses_|message\/)/.test(req.path) && !hints.length) {
        return res.status(403).json({ error: 'A folder scope is required while private folders are locked.', code: 'zdr_locked' });
      }
      const match = req.path.match(/^\/projects\/([^/]+)(?:\/|$)/);
      const projectIDs = scopes([match?.[1], req.body?.projectId, req.body?.parameters?.projectId]);
      if (projectIDs.length) {
        const projects = await listProjects();
        for (const id of projectIDs) {
          const project = projects.find((item) => item.id === decodeURIComponent(id));
          if (!project) return res.status(403).json({ error: 'Folder could not be verified.', code: 'zdr_locked' });
          hints.push(project.path);
        }
      }
      for (const hint of hints) {
        let directory = hint;
        try { directory = decodeURIComponent(hint); } catch { /* Refuse malformed scoped input below. */ }
        const allowed = privacy ? await privacy.allowsDirectory(directory, { fresh: true }) : (await folderGuard.check(path.resolve(directory))).ok;
        if (!allowed) {
          res.setHeader('Cache-Control', 'no-store');
          return res.status(403).json({ error: 'This folder is locked.', code: 'zdr_locked' });
        }
      }
      return next();
    } catch { return res.status(503).json({ error: 'Lock state unavailable', code: 'zdr_lock_unavailable' }); }
  });
};

import express from 'express';

const parseJsonBody = express.json({ limit: '4kb' });
const isZdrBound = (providers) => providers.some((provider) => /zdr/i.test(provider));

/**
 * `state` says whether a PIN is set and which folders it guards: every configured folder bound to
 * a zero-retention provider. The check itself stays on the server.
 */
export const registerZdrLockRoutes = (app, { lock, listProjectPaths, resolveAllowedProviders, path }) => {
  app.get('/api/openchamber/zdr-lock/state', async (_req, res) => {
    const directories = [];
    try {
      for (const item of (await listProjectPaths()) || []) {
        const resolved = path.resolve(item);
        if (isZdrBound(await resolveAllowedProviders(resolved))) directories.push(resolved);
      }
    } catch { /* A folder that cannot be read is not reported as guarded. */ }
    res.json({ pinSet: lock.isSet(), directories, retryAfterMs: lock.retryAfterMs() });
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
};

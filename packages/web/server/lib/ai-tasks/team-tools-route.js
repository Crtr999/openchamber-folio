/** Reuses the managed child's in-memory credential on the existing host listener. */
export function registerTeamToolsRoute(app, { authorizeRequest, getTeam, express }) {
  app.post('/api/openchamber/team-tool', express.json({ limit: '1mb' }), async (req, res) => {
    if (!authorizeRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
    const team = getTeam();
    if (!team) return res.status(503).json({ error: 'Team host unavailable' });
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort); res.once('close', abort);
    try {
      return res.json(await team.executeTool(req.body, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) }));
    } catch {
      return res.status(403).json({ error: 'Team operation could not be authorized or completed. Inspect the run before retrying.' });
    } finally { req.off('aborted', abort); res.off('close', abort); }
  });
}

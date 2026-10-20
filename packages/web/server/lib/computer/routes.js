/**
 * The computer, as the app shows it.
 *
 * One route: which screens the agent's computer has open. The address comes
 * back with it, so the app can open that computer in its own browser panel.
 * The key does not: it stays here, and the panel is given a cookie instead.
 */

import express from 'express';

const parseJsonBody = express.json({ limit: '1mb' });

export const registerComputerRoutes = (app, dependencies) => {
  const { resolveEndpoint, fetchState } = dependencies;

  app.get('/api/computer/state', async (req, res) => {
    try {
      const endpoint = resolveEndpoint();
      if (!endpoint) {
        return res.json({ available: false, baseUrl: null, screens: [] });
      }
      const state = await fetchState(endpoint);
      return res.json({ ...state, baseUrl: endpoint.baseUrl });
    } catch {
      // A computer that cannot be reached is an ordinary state, not an error:
      // the app shows "not running", which is the truth.
      return res.json({ available: false, baseUrl: null, screens: [] });
    }
  });
};

export { parseJsonBody };

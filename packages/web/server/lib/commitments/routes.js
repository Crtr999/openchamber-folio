import express from 'express';
import { z, ZodError } from 'zod';
import { commitmentSettingsSchema } from './store.js';

const createBody = z.object({
  title: z.string().trim().min(1).max(160),
  dueAt: z.number().int().nullable().default(null),
  watches: z.array(z.string().trim().min(1).max(200)).max(5).default([]),
  research: z.boolean().default(true),
}).strict().refine((value) => value.dueAt !== null || value.watches.length > 0, {
  message: 'Give a date or something to watch',
});

const settingsBody = commitmentSettingsSchema.partial().strict();

// What the app sees. Dismissed items stay on disk so the same deadline is not
// added again, but they are not listed.
const publicView = (state) => ({ settings: state.settings, items: state.items.filter((item) => item.status !== 'dismissed') });

/**
 * The commitments list for the app. Registered behind the API's existing
 * authentication. Nothing here lets a caller reach a model: the only agent
 * action is a check of an item the user already has.
 */
export const registerCommitmentRoutes = (app, { store, checks, onChanged = () => {} }) => {
  const json = express.json({ limit: '16kb' });
  const base = '/api/commitments';
  const handle = (work) => async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try { return await work(req, res); } catch (error) {
      if (error instanceof ZodError) return res.status(400).json({ error: error.issues[0]?.message || 'Invalid request' });
      if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
      return next(error);
    }
  };

  app.get(base, handle(async (req, res) => res.json(publicView(await store.read()))));

  app.post(base, json, handle(async (req, res) => {
    const body = createBody.parse(req.body);
    const item = await store.add({ ...body, origin: 'manual', confirmedAt: Date.now() });
    onChanged();
    return res.status(201).json({ item });
  }));

  app.put(`${base}/settings`, json, handle(async (req, res) => {
    const settings = await store.setSettings(settingsBody.parse(req.body));
    onChanged();
    return res.json({ settings });
  }));

  app.patch(`${base}/:id`, json, handle(async (req, res) => {
    const item = await store.patch(req.params.id, req.body);
    if (!item) return res.status(404).json({ error: 'Commitment not found' });
    onChanged();
    return res.json({ item });
  }));

  // Removing keeps a hidden record, so a deadline the user removed is not
  // noticed and added again from the same conversation.
  app.delete(`${base}/:id`, handle(async (req, res) => {
    const item = await store.patch(req.params.id, { status: 'dismissed' });
    if (!item) return res.status(404).json({ error: 'Commitment not found' });
    onChanged();
    return res.status(204).end();
  }));

  app.post(`${base}/:id/check`, json, handle(async (req, res) => {
    const result = await checks.checkNow(req.params.id);
    if (result.started) return res.status(202).json(result);
    const status = { 'not-found': 404, excluded: 403, busy: 409 }[result.reason] ?? 502;
    return res.status(status).json(result);
  }));
};

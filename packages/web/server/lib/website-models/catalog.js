import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Models each website account offers in its own picker. The bridge selects the
 * model by its display name on the page before it sends. The seed below is what
 * the pickers listed when this was written; the app refreshes the saved copy
 * from the live pages, and the refreshed list is used the next time it starts.
 */
export const modelSlug = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

const SEED = {
  venice: [
    'Auto', 'Claude Fable 5.1', 'Claude Opus 5', 'Claude Sonnet 4.6', 'DeepSeek V4.1 Flash', 'Gemini 3.8 Flash', 'GLM 5.3 Flash',
    'GLM 4.7 Flash Heretic', 'GLM 4.6', 'GPT-6 Astra', 'Grok 4.7', 'Kimi K3.1 Pro', 'Muse Spark Open', 'Muse Wonder',
    'Qwen 3.8 Max', 'Qwen 3.7 Plus', 'Venice Uncensored 1.2',
  ],
  gemini: ['3.5 Flash-Lite', '3.8 Flash', '3.1 Pro', '4 Argon'],
};

const entrySchema = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/), name: z.string().min(1).max(120), paid: z.boolean().optional() });
const catalogSchema = z.object({ venice: z.array(entrySchema).max(200), gemini: z.array(entrySchema).max(200) });

const toEntries = (names, paid = []) => [...new Map(names.map(name => [modelSlug(name), { id: modelSlug(name), name, ...(paid.includes(name) ? { paid: true } : {}) }])).values()].filter(entry => entry.id);

// On a free Venice account only these run without credits; the rest need a balance.
const VENICE_FREE = ['Auto', 'GLM 4.7 Flash Heretic', 'GLM 4.6', 'Venice Uncensored 1.2'];

export const defaultCatalog = () => ({ venice: toEntries(SEED.venice, SEED.venice.filter(name => !VENICE_FREE.includes(name))), gemini: toEntries(SEED.gemini) });

export function readCatalogFile(file) {
  if (!file) return defaultCatalog();
  try {
    const parsed = catalogSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (parsed.success && parsed.data.venice.length && parsed.data.gemini.length) return parsed.data;
  } catch { /* A missing or damaged file falls back to the seed. */ }
  return defaultCatalog();
}

export function writeCatalogFile(file, catalog) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(catalog, null, 2) + '\n', { mode: 0o600 });
  } catch { /* The catalog is a cache; failing to save it is not an error for chats. */ }
}

/** Accepts the display names scraped from a live picker. */
export function catalogFromNames(provider, names, current, paidNames = []) {
  const clean = names.filter(name => typeof name === 'string').map(name => name.trim()).filter(name => name && name.length <= 120);
  const entries = toEntries(clean, paidNames.filter(name => typeof name === 'string'));
  if (!entries.length || entries.length > 200) return current;
  return { ...current, [provider]: entries };
}

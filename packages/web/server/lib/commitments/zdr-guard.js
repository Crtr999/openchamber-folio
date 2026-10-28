import path from 'node:path';
import { z } from 'zod';

const directorySchema = z.string().min(1).refine((value) => value.trim().length > 0);
const stringsSchema = z.array(z.string());

// Deliberately wider than the folder-name rule in the UI: a match anywhere in
// the path counts, because a false positive only means a folder is not
// tracked, and a false negative would put zero-retention material into a list.
export const isZdrNamed = (directory) => /zdr/i.test(directory);

const isInside = (directory, parent) => {
  const target = path.resolve(directory);
  const base = path.resolve(parent);
  return target === base || target.startsWith(`${base}${path.sep}`);
};

/**
 * Decides whether a folder's conversations may feed the commitments list.
 *
 * It fails closed: a folder it cannot judge is not tracked. The ZDR
 * rule cannot be turned off by a setting; the user's own exclusions are an
 * extra on top of it.
 */
export const createFolderGuard = ({ resolveAllowedProviders, readExcludedDirectories = async () => [], listProjectPaths = async () => [] }) => {
  const check = async (directory, providerID) => {
    const parsedDirectory = directorySchema.safeParse(directory);
    if (!parsedDirectory.success) return { ok: false, reason: 'no-directory' };
    directory = parsedDirectory.data;
    if (isZdrNamed(directory)) return { ok: false, reason: 'zdr-name' };
    // A child directory must not shed the configured parent's provider boundary.
    // Inspect that boundary before touching the child's configuration.
    let projects;
    try { projects = stringsSchema.parse(await listProjectPaths()); }
    catch { return { ok: false, reason: 'binding-unreadable' }; }
    for (const parent of projects) {
      if (path.resolve(directory) === path.resolve(parent) || !isInside(directory, parent)) continue;
      if (isZdrNamed(parent)) return { ok: false, reason: 'zdr-name' };
      try {
        const binding = stringsSchema.parse(await resolveAllowedProviders(parent));
        if (binding.some((provider) => /zdr/i.test(provider))) return { ok: false, reason: 'zdr-bound' };
      } catch { return { ok: false, reason: 'binding-unreadable' }; }
    }
    let providers;
    try { providers = stringsSchema.parse(await resolveAllowedProviders(directory)); }
    catch { return { ok: false, reason: 'binding-unreadable' }; }
    if (providerID && providers.some((provider) => provider !== providerID)) return { ok: false, reason: 'provider-bound' };
    if (providers.some((provider) => /zdr/i.test(provider))) return { ok: false, reason: 'zdr-bound' };
    let excluded;
    try { excluded = stringsSchema.parse(await readExcludedDirectories()); }
    catch { return { ok: false, reason: 'settings-unreadable' }; }
    if (excluded.some((entry) => isInside(directory, entry))) return { ok: false, reason: 'excluded' };
    return { ok: true };
  };
  return { check };
};

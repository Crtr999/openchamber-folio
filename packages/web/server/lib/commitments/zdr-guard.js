import path from 'node:path';

const ZDR_PROVIDER = 'openrouter-zdr';

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
export const createFolderGuard = ({ resolveAllowedProviders, readExcludedDirectories = async () => [] }) => {
  const check = async (directory, providerID) => {
    if (typeof directory !== 'string' || !directory.trim()) return { ok: false, reason: 'no-directory' };
    if (isZdrNamed(directory)) return { ok: false, reason: 'zdr-name' };
    let providers;
    try { providers = await resolveAllowedProviders(directory); }
    catch { return { ok: false, reason: 'binding-unreadable' }; }
    if (!Array.isArray(providers)) return { ok: false, reason: 'binding-unreadable' };
    if (providerID && providers.some((provider) => provider !== providerID)) return { ok: false, reason: 'provider-bound' };
    if (providers.includes(ZDR_PROVIDER)) return { ok: false, reason: 'zdr-bound' };
    let excluded;
    try { excluded = await readExcludedDirectories(); }
    catch { return { ok: false, reason: 'settings-unreadable' }; }
    if (excluded.some((entry) => isInside(directory, entry))) return { ok: false, reason: 'excluded' };
    return { ok: true };
  };
  return { check };
};

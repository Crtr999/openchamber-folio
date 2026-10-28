import path from 'node:path';
import { z } from 'zod';

const text = z.string().min(1);
const strings = z.array(text);
const readText = (value) => { const parsed = text.safeParse(value); return parsed.success ? parsed.data : null; };
const inside = (target, root) => target === root || target.startsWith(root === path.parse(root).root ? root : `${root}${path.sep}`);

/** Global browser transports never carry private folders. Only an explicitly
 * scoped HTTP stream/read with a live PIN grant may carry that folder's data.
 * Cached event decisions contain paths/verdicts only, never message content.
 */
export const createZdrPrivacy = ({ folderGuard, listProjectPaths, listProjects, realpath, resolveSessionDirectory, lock }) => {
  let snapshot;
  const sessionDirectories = new Map();
  const sessionDirectory = async (id) => {
    if (!sessionDirectories.has(id)) {
      if (sessionDirectories.size >= 4096) sessionDirectories.clear();
      sessionDirectories.set(id, Promise.resolve(resolveSessionDirectory(id)).catch(() => null));
    }
    return sessionDirectories.get(id);
  };
  const canonical = async (input) => {
    const directory = text.parse(input);
    const absolute = path.resolve(directory);
    try { return await realpath(absolute); }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(absolute);
      if (parent === absolute) throw error;
      return path.join(await canonical(parent), path.basename(absolute));
    }
  };
  const build = async () => {
    const roots = [];
    for (const directory of strings.parse(await listProjectPaths())) {
      const resolved = await canonical(directory);
      const privateFolder = /zdr/i.test(directory) || /zdr/i.test(resolved) || !(await folderGuard.check(directory)).ok;
      roots.push({ directory: resolved, privateFolder });
    }
    const decisions = new Map();
    return async (input) => {
      // Re-resolve the filesystem identity before consulting a policy cache:
      // replacing a symlink must never retain its previous public decision.
      const directory = await canonical(input);
      if (/zdr/i.test(input) || /zdr/i.test(directory)) return { directory, privateFolder: true };
      let decision = decisions.get(directory);
      if (!decision) {
        if (decisions.size >= 4096) decisions.clear();
        decision = (async () => {
          if (roots.some((root) => root.privateFolder && inside(directory, root.directory))) return { directory, privateFolder: true };
          return { directory, privateFolder: !(await folderGuard.check(directory)).ok };
        })();
        decisions.set(directory, decision);
      }
      return decision;
    };
  };
  const invalidate = () => { snapshot = undefined; sessionDirectories.clear(); };
  const policy = async () => {
    snapshot ??= build();
    const pending = snapshot;
    try { return await pending; }
    catch (error) { if (snapshot === pending) snapshot = undefined; throw error; }
  };
  const classify = async (directory, fresh = false) => {
    if (fresh) return (await build())(directory);
    return (await policy())(directory);
  };
  const allowsDirectory = async (directory, { scope, token, fresh = false } = {}) => {
    try {
      const decision = await classify(text.parse(directory), fresh);
      if (!decision.privateFolder) return true;
      let decodedScope = scope;
      try { if (scope) decodedScope = decodeURIComponent(scope); } catch { /* An invalid path cannot match. */ }
      if (!decodedScope || !(await classify(decodedScope)).privateFolder) return false;
      const scopeDirectory = await canonical(decodedScope);
      return Boolean(inside(decision.directory, scopeDirectory) && (!lock.isSet() || lock.isAuthorized(token)));
    } catch { return false; }
  };
  const filterSessions = async (sessions, options = {}) => {
    await policy();
    const result = [];
    for (const session of sessions) {
      const directory = readText(session?.location?.directory) ?? readText(session?.directory);
      if (directory && readText(session?.id)) sessionDirectories.set(session.id, Promise.resolve(directory));
      if (directory && await allowsDirectory(directory, options)) result.push(session);
    }
    return result;
  };
  const filterEvent = async (payload, { directory: hint, ...options } = {}) => {
    if (!payload) return null;
    if (/^config\./.test(payload.type ?? '')) invalidate();
    if (payload.type === 'openchamber:worktree-changed') {
      const references = strings.safeParse(payload.properties?.directories);
      if (!references.success) return null;
      const directories = [];
      for (const reference of references.data) if (await allowsDirectory(reference, options)) directories.push(reference);
      return directories.length ? { ...payload, properties: { ...payload.properties, directories } } : null;
    }
    let directory = readText(payload.location?.directory) ?? readText(payload.properties?.directory) ?? readText(payload.properties?.path) ?? readText(hint);
    const sessionID = readText(payload.sessionID) ?? readText(payload.properties?.sessionID) ?? readText(payload.properties?.sessionId)
      ?? readText(payload.properties?.session?.id) ?? readText(payload.data?.sessionID);
    if (directory === 'global') directory = null;
    if (!directory) {
      const projectID = readText(payload.properties?.projectId) ?? readText(payload.properties?.projectID);
      if (projectID) directory = (await listProjects()).find((project) => project.id === projectID)?.path ?? null;
    }
    if (!directory) {
      if (sessionID) directory = await sessionDirectory(sessionID);
    }
    if (directory && sessionID) sessionDirectories.set(sessionID, Promise.resolve(directory));
    if (directory) return await allowsDirectory(directory, options) ? payload : null;
    if (payload.type === 'openchamber:agent-memory-changed' && payload.properties?.scope === 'global') return payload;
    // Directory-less content is unknown, never proof of public scope.
    return /^(?:server\.(?:connected|heartbeat)|openchamber:(?:heartbeat|event-stream-ready|notification-stream-ready|computer-state|browser-control-request|browser-provider-reset))$/.test(payload.type ?? '') ? payload : null;
  };
  const filterActive = async (active, options = {}) => {
    await policy();
    const visible = {};
    for (const [id, status] of Object.entries(active)) {
      const directory = await sessionDirectory(id);
      if (directory && await allowsDirectory(directory, options)) visible[id] = status;
    }
    return visible;
  };
  return { canonical, allowsDirectory, filterSessions, filterActive, filterEvent, invalidate };
};

/** Preserve complete SSE blocks and backpressure. Never forward a partial JSON
 * frame before its directory has been classified. A malformed/oversized frame
 * fails closed instead of leaking an unexamined prefix.
 */
export const createPrivateSseFilter = ({ privacy, options = {}, maxFrameBytes = 16 * 1024 * 1024 }) => {
  const decoder = new TextDecoder();
  let pending = '';
  return async (bytes) => {
    pending += decoder.decode(bytes, { stream: true }).replace(/\r\n/g, '\n');
    if (Buffer.byteLength(pending) > maxFrameBytes) throw new Error('Event frame exceeds privacy buffer');
    const output = [];
    let boundary;
    while ((boundary = pending.indexOf('\n\n')) >= 0) {
      const block = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (!data) { output.push(`${block}\n\n`); continue; }
      try {
        const parsed = JSON.parse(data);
        const envelope = parsed.payload ? parsed : { payload: parsed };
        const filtered = await privacy.filterEvent(envelope.payload, { ...options, directory: envelope.directory });
        if (!filtered) continue;
        if (filtered === envelope.payload) output.push(`${block}\n\n`);
        else {
          const headers = block.split('\n').filter((line) => !line.startsWith('data:'));
          headers.push(`data: ${JSON.stringify(parsed.payload ? { ...parsed, payload: filtered } : filtered)}`);
          output.push(`${headers.join('\n')}\n\n`);
        }
      } catch { /* Malformed or unclassifiable content is not public. */ }
    }
    return output.join('');
  };
};

import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const querySchema = z.object({
  app: z.enum(['calendar', 'reminders']), containerId: z.string().min(1).max(1024),
  start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }),
  limit: z.number().int().min(1).max(100),
}).strict().refine((query) => Date.parse(query.end) > Date.parse(query.start)
  && Date.parse(query.end) - Date.parse(query.start) <= 31 * 86_400_000);
const itemSchema = z.object({ id: z.string(), title: z.string(), start: z.string().nullable(), end: z.string().nullable(), allDay: z.boolean() }).strict();
const resultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), items: z.array(itemSchema).max(100), truncated: z.boolean() }).strict(),
  z.object({ status: z.literal('containers'), containers: z.array(z.object({ id: z.string(), title: z.string() }).strict()).max(100), truncated: z.boolean() }).strict(),
  z.object({ status: z.enum(['permission-required', 'permission-denied', 'unsupported', 'error', 'container-unavailable']), reason: z.string() }).strict(),
]);

/** Executes only the bundled read-only EventKit helper, never an app or a shell. */
export function createNativeAppReader({ executable, platform = process.platform, spawnProcess = spawn, requestApproval }) {
  const run = async (query, signal) => {
      if (platform !== 'darwin') return { status: 'unsupported', reason: 'EventKit is available only on macOS.' };
      if (signal?.aborted) return { status: 'error', reason: 'Native read cancelled.' };
      return new Promise((resolve) => {
        let child;
        let output = '';
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          resolve(result);
        };
        const stop = (reason) => { child?.kill(); finish({ status: 'error', reason }); };
        const abort = () => stop('Native read cancelled.');
        const timer = setTimeout(() => stop('Native read timed out.'), 20_000);
        try { child = spawnProcess(executable, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false }); }
        catch { finish({ status: 'unsupported', reason: 'Bundled native reader is unavailable.' }); return; }
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        child.on('error', () => finish({ status: 'unsupported', reason: 'Bundled native reader is unavailable.' }));
        child.stdin.on('error', () => stop('Native reader input failed.'));
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          if (settled) return;
          output += chunk;
          if (Buffer.byteLength(output) > 512 * 1024) stop('Native reader output exceeded its limit.');
        });
        child.on('close', (code) => {
          if (settled) return;
          if (code !== 0) { finish({ status: 'error', reason: 'Native reader exited without a result.' }); return; }
          try {
            const result = resultSchema.parse(JSON.parse(output));
            if (result.status === 'ok' && (query.op !== 'read' || result.items.length > query.limit)) throw new Error('Unexpected read result');
            if (result.status === 'containers' && query.op !== 'containers') throw new Error('Unexpected container result');
            finish(result);
          } catch { finish({ status: 'error', reason: 'Native reader returned an invalid result.' }); }
        });
        child.stdin.end(JSON.stringify(query));
      });
  };
  return {
    runtimeId: randomUUID(),
    requestApproval,
    status: () => {
      let installed = false;
      if (platform === 'darwin') {
        try { accessSync(executable, constants.X_OK); installed = statSync(executable).isFile(); } catch { /* Missing helper is unsupported, never a ready reader. */ }
      }
      return { status: installed ? 'available' : 'unsupported',
        apps: { calendar: installed ? 'scoped-eventkit' : 'unsupported', reminders: installed ? 'scoped-eventkit' : 'unsupported', notes: 'unsupported', mail: 'unsupported' },
        permissions: 'not-checked', requires: ['directory-provider-container-grant', 'existing-os-access'], background: true };
    },
    read: async (input, signal) => {
      const query = querySchema.parse(input);
      return run({ ...query, op: 'read' }, signal);
    },
    containers: async (input, signal) => {
      const query = z.object({ app: z.enum(['calendar', 'reminders']) }).strict().parse(input);
      return run({ ...query, op: 'containers' }, signal);
    },
  };
}

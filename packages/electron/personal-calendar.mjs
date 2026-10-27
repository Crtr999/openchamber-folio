import { spawn } from 'node:child_process';
import { z } from 'zod';
const requestSchema = z.object({ op: z.enum(['read', 'connect', 'save', 'reminders-read', 'reminders-connect', 'reminder-complete', 'reminder-save']), id: z.string().max(2000).optional(), title: z.string().max(2000).optional(), start: z.string().max(100).optional(), end: z.string().max(100).optional(), due: z.string().max(100).optional(), calendarId: z.string().max(2000).optional() });
const resultSchema = z.object({ access: z.enum(['connected', 'not-connected', 'unsupported']), calendars: z.array(z.object({ id: z.string(), title: z.string(), writable: z.boolean() })).optional(), events: z.array(z.object({ id: z.string(), title: z.string(), start: z.string(), end: z.string(), allDay: z.boolean(), calendarId: z.string(), calendarTitle: z.string(), writable: z.boolean() })).optional(), reminders: z.array(z.object({ id: z.string(), title: z.string(), due: z.string().nullable(), overdue: z.boolean(), priority: z.enum(['none', 'low', 'medium', 'high']), list: z.string() })).optional(), savedId: z.string().optional(), error: z.string().optional() });
export function createPersonalCalendar({ executable, platform = process.platform }) {
  return async (raw) => {
    const request = requestSchema.parse(raw);
    if (platform !== 'darwin') return { access: 'unsupported' };
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; let failed = false;
      const timer = setTimeout(() => { failed = true; child.kill(); reject(new Error('Calendar access timed out. Try again.')); }, request.op === 'connect' || request.op === 'reminders-connect' ? 100000 : 20000);
      const fail = () => { if (!failed) { failed = true; clearTimeout(timer); reject(new Error('Could not open the calendar connection.')); } };
      child.on('error', fail);
      child.stdout.on('data', (data) => { output += data.toString(); if (output.length > 2000000) { fail(); child.kill(); } });
      child.stderr.resume();
      child.stdin.on('error', fail);
      child.on('close', (code) => {
        clearTimeout(timer); if (failed) return;
        if (code !== 0) { fail(); return; }
        try { resolve(resultSchema.parse(JSON.parse(output))); } catch { fail(); }
      });
      child.stdin.end(JSON.stringify(request));
    });
  };
}

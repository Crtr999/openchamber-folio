import React from 'react';
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isElectronShell, isDesktopLocalOriginActive } from '@/lib/desktop';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { buildWebsiteAccountScript, buildWebsiteChatScript, websiteAccountActionSchema, websiteChatSnapshotSchema, websiteChatActionSchema, waitForWebsiteSnapshot } from '@/lib/website-chat/websiteChat';

const jobSchema = z.object({ id: z.string().uuid(), lease: z.string().uuid(), provider: z.enum(['venice', 'gemini']), kind: z.enum(['chat', 'usage', 'models']).default('chat'), prompt: z.string().max(300_000), model: z.string().max(120).nullish() });
type Job = z.infer<typeof jobSchema>;
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const wait = (signal: AbortSignal, ms: number) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new Error('Cancelled')); return; }
  const abort = () => { clearTimeout(timer); reject(new Error('Cancelled')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true });
});

function WebsiteModelJob({ job, signal, finish, userFocus }: { job: Job; signal: AbortSignal; finish: (id: string) => void; userFocus: React.RefObject<HTMLElement | null> }) {
  const [webview, setWebview] = React.useState<WebviewElement | null>(null);
  const attachWebview = React.useCallback((node: WebviewElement | null) => setWebview(node), []);
  React.useEffect(() => {
    if (!webview) return;
    let alive = true;
    const post = (path: string, payload: Record<string, unknown>) => runtimeFetch('/api/openchamber/website-models/jobs/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job.id, lease: job.lease, ...payload }), signal });
    const waitReady = async (read: () => Promise<z.infer<typeof websiteChatSnapshotSchema>>, ensureActive: () => Promise<void>, deadline: number, phaseWord: string) => {
      while (alive && !signal.aborted && Date.now() < deadline) {
        await ensureActive();
        try { const row = await read(); if (row.kind === 'ready') return row; } catch { /* Guest may still be attaching or loading. */ }
        if (Date.now() > deadline - 130_000 && phaseWord === 'chat') throw new Error('Sign in through the ' + job.provider + ' account connection, then resend your message.');
        await wait(signal, 500);
      }
      return null;
    };
    const runAccountJob = async () => {
      // Usage and model lists are read-only: they never send a message.
      try {
        const deadline = Date.now() + 50_000;
        let checkAt = 0;
        const ensureActive = async () => {
          if (Date.now() - checkAt < 2000) return;
          checkAt = Date.now();
          const status = z.object({ active: z.boolean() }).parse(await (await post('check', { phase: 'loading' })).json());
          if (!status.active) throw new Error('Request cancelled.');
        };
        if (job.kind === 'models' || job.provider === 'venice') {
          const read = async () => websiteChatSnapshotSchema.parse(await webview.executeJavaScript(buildWebsiteChatScript(job.provider, { kind: 'snapshot' }), false));
          if (!(await waitReady(read, ensureActive, deadline, 'account'))) throw new Error('The ' + job.provider + ' website did not finish loading. Sign in through its account connection.');
        } else {
          // Gemini's usage page is its own route.
          while (alive && !signal.aborted && Date.now() < deadline) {
            await ensureActive();
            try { if (String(await webview.executeJavaScript('location.origin + location.pathname', false)).endsWith('/usage')) break; } catch { /* still loading */ }
            await wait(signal, 400);
          }
        }
        const result = websiteAccountActionSchema.parse(await webview.executeJavaScript(buildWebsiteAccountScript(job.provider, { kind: job.kind === 'models' ? 'models' : 'usage' }), true));
        if (result.kind === 'failed' || result.kind === 'unavailable') throw new Error(result.reason);
        await post('result', { data: result });
      } catch (error) {
        if (alive && !signal.aborted) { try { await post('result', { error: error instanceof Error ? error.message : 'Website account failed.' }); } catch { /* The server owns its request deadline. */ } }
      } finally { if (alive) finish(job.id); }
    };
    const run = async () => {
      if (job.kind !== 'chat') { await runAccountJob(); return; }
      let submitted = false;
      let completed = false;
      const read = async () => websiteChatSnapshotSchema.parse(await webview.executeJavaScript(buildWebsiteChatScript(job.provider, { kind: 'snapshot' }), false));
      try {
        const deadline = Date.now() + 220_000;
        let checkAt = 0;
        let phase = 'loading';
        const check = async (text?: string) => {
          checkAt = Date.now();
          const response = await post('check', text === undefined ? { phase } : { phase, text });
          const status = z.object({ active: z.boolean() }).parse(await response.json());
          if (!status.active) throw new Error('Native model request cancelled.');
        };
        const ensureActive = async () => { if (Date.now() - checkAt >= 2000) await check(); };
        const start = await waitReady(read, ensureActive, deadline, 'chat');
        if (!start || !alive || signal.aborted) throw new Error('Website account connection cancelled.');
        if (start.busy || start.messages.length || start.draft.trim()) throw new Error('The website did not open a fresh chat. Nothing was sent; check its account connection.');
        if (job.model) {
          // Pick the model the person chose in the native picker before anything is sent.
          phase = 'selecting-model';
          await check();
          const picked = websiteAccountActionSchema.parse(await webview.executeJavaScript(buildWebsiteAccountScript(job.provider, { kind: 'select-model', name: job.model }), true));
          if (picked.kind !== 'selected') throw new Error(picked.kind === 'unavailable' ? picked.reason : picked.kind === 'failed' ? 'Could not choose ' + job.model + ': ' + picked.reason : 'Could not choose ' + job.model + '.');
        }
        phase = 'sending';
        const currentFocus = document.activeElement;
        const focused = currentFocus instanceof HTMLElement && currentFocus.tagName !== 'WEBVIEW' ? currentFocus : userFocus.current;
        let sent;
        try {
          sent = websiteChatActionSchema.parse(await webview.executeJavaScript(buildWebsiteChatScript(job.provider, { kind: 'send', text: job.prompt, url: start.url, expectedDraft: start.draft }), true));
        } finally {
          if (document.activeElement === webview && focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true });
        }
        if (sent.kind !== 'submitted') throw new Error('The website did not accept the message (' + sent.kind + '). No automatic retry was made.');
        submitted = true;
        phase = 'reading';
        const sentAt = Date.now();
        let lastText = '', stableSince = 0, acknowledged = false, pushed = '';
        while (alive && !signal.aborted && Date.now() < deadline) {
          await ensureActive();
          const snapshot = await waitForWebsiteSnapshot({ read, ensureActive, wait: () => { phase = 'waiting-for-page'; return wait(signal, 500); } });
          const users = snapshot.messages.filter(row => row.role === 'user');
          if (users.length > 0 || snapshot.userCount > 0 || users.some(row => normalize(row.text).endsWith(normalize(job.prompt)))) acknowledged = true;
          phase = acknowledged ? 'waiting-for-answer' : 'waiting-for-message';
          const answer = snapshot.messages.at(-1);
          if (acknowledged && answer?.role === 'assistant' && answer.text.trim()) {
            if (lastText !== answer.text) { lastText = answer.text; stableSince = Date.now(); }
            // Hand the growing reply to the native chat as the website writes it.
            if (answer.text !== pushed && answer.text.length > pushed.length) { pushed = answer.text; await check(answer.text); }
            if (!snapshot.busy && Date.now() - stableSince >= (job.provider === 'venice' ? 2500 : 1500)) {
              const response = await post('result', { text: answer.text });
              if (!response.ok) throw new Error('Open Carter could not receive the website reply.');
              completed = true; break;
            }
          }
          if (!acknowledged && Date.now() > sentAt + 20_000) throw new Error('The website did not confirm this message. Check its account connection before retrying.');
          await wait(signal, 250);
        }
        if (!completed) throw new Error('The website response was cancelled or timed out.');
      } catch (error) {
        if (submitted && !completed) {
          try { const row = await read(); if (row.kind === 'ready' && row.busy) await webview.executeJavaScript(buildWebsiteChatScript(job.provider, { kind: 'stop', url: row.url }), true); } catch { /* No retry after an uncertain website action. */ }
        }
        if (alive && !signal.aborted) {
          try { await post('result', { error: error instanceof Error ? error.message : 'Website account failed.' }); } catch { /* The server owns its request deadline. */ }
        }
      } finally { if (alive) finish(job.id); }
    };
    void run();
    return () => { alive = false; };
  }, [webview, job, signal, finish, userFocus]);
  const src = job.provider === 'venice' ? 'https://venice.ai/chat/classic' : job.kind === 'usage' ? 'https://gemini.google.com/usage' : 'https://gemini.google.com/app';
  return <webview tabIndex={-1} ref={attachWebview} src={src} partition={`persist:open-carter-${job.provider}`} webpreferences="backgroundThrottling=no" style={{ width: '1200px', height: '900px', border: 'none' }} />;
}

/** Account workers are local-only. The ordinary ChatContainer owns every turn. */
export function WebsiteModelRuntime() {
  const blocked = useEnterpriseMode();
  const userFocus = React.useRef<HTMLElement | null>(null);
  const [jobs, setJobs] = React.useState<Job[]>([]);
  const [runtimeGeneration, setRuntimeGeneration] = React.useState(0);
  const [controller, setController] = React.useState<AbortController | null>(null);
  const finish = React.useCallback((id: string) => setJobs(rows => rows.filter(row => row.id !== id)), []);
  React.useEffect(() => subscribeRuntimeEndpointChanged(() => setRuntimeGeneration(value => value + 1)), []);
  React.useEffect(() => {
    if (blocked || !isElectronShell() || !isDesktopLocalOriginActive()) { setJobs([]); return; }
    const control = new AbortController(); setController(control); setJobs([]);
    const rememberFocus = () => {
      const element = document.activeElement;
      if (element instanceof HTMLElement && element.tagName !== 'WEBVIEW') userFocus.current = element;
    };
    rememberFocus(); document.addEventListener('focusin', rememberFocus);
    const listen = async () => {
      while (!control.signal.aborted) {
        try {
          const response = await runtimeFetch('/api/openchamber/website-models/jobs/next', { signal: control.signal });
          if (response.status === 204) continue;
          if (!response.ok) throw new Error('Website worker unavailable');
          const job = jobSchema.parse(await response.json());
          if (!control.signal.aborted) setJobs(rows => rows.some(row => row.id === job.id) ? rows : [...rows, job]);
        } catch {
          if (control.signal.aborted) break;
          try { await wait(control.signal, 3000); } catch { break; }
        }
      }
    };
    void listen();
    return () => { control.abort(); setJobs([]); document.removeEventListener('focusin', rememberFocus); };
  }, [blocked, runtimeGeneration]);
  if (!controller || blocked) return null;
  return <div aria-hidden="true" className="pointer-events-none fixed left-0 top-0 h-[900px] w-[1200px] opacity-0">
    {jobs.map(job => <WebsiteModelJob key={job.id} job={job} signal={controller.signal} finish={finish} userFocus={userFocus} />)}
  </div>;
}

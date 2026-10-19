import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { HomeTeamRun, HomeTeamRoutine } from '@/lib/personal-home';

const teammate = { id: 'manager-research', projectId: 'research', projectLabel: 'Research', directory: '/projects/research', agent: 'manager', role: 'manager', revision: 3, readRevision: 0 };
const usage = { kind: 'unavailable', tokens: 0, reportedCost: 0, sessionIds: [], dollarCapSupported: false } satisfies HomeTeamRun['usage'];
const failedRun: HomeTeamRun = { id: 'failed', taskId: 'task-failed', teammateId: teammate.id, projectId: teammate.projectId, directory: teammate.directory, title: 'Failed assignment', text: 'Keep the evidence', phase: 'needs-you', startedAt: 1, revision: 1, failure: { stage: 'create', code: 'http_500', message: 'Chat creation failed.', at: 1 }, children: [], artifacts: [], usage, inspectFailures: 0 };
const completedRun: HomeTeamRun = { ...failedRun, id: 'completed', taskId: 'task-completed', title: 'Completed assignment', phase: 'done', failure: { stage: 'inspect', code: 'http_503', message: 'Child evidence could not be verified.', at: 2 }, sessionId: 'ses_parent', content: 'Saved result remains readable.', inspectFailures: 1, children: [{ id: 'ses_child', title: 'Actual direct child', directory: '/projects/research' }], artifacts: [{ path: 'result.md', label: 'Result evidence', sessionId: 'ses_child', messageId: 'msg_result' }] };
const proposal: HomeTeamRoutine = { id: 'routine', teammateId: teammate.id, projectId: teammate.projectId, revision: 'proposal-v1', title: 'Weekly review', text: 'Review this project only', schedule: { kind: 'weekly', weekdays: [1], time: '09:00', timezone: 'America/Chicago' }, allowedActions: ['read-project'], limits: { maxOccurrences: 4, tokenGuardrail: 10000 }, status: 'proposed', occurrences: 0, policyRevision: 'rules-v1' };
const host = { platform: 'darwin', coordinator: { state: 'paused', enabled: false, lastCheckedAt: null, nextCheckAt: null, hasError: false }, teamWork: { state: 'required' }, wakeProtection: { supported: true, enabled: false, active: false, source: 'none', reason: 'paused' }, power: { state: 'awake', lastSuspendAt: null, lastResumeAt: null }, diagnostics: ['app_must_remain_running', 'lid_may_suspend', 'network_not_verified'] };

type BridgeInput = { action?: string; projectId?: string; teammateId?: string; runId?: string; requestId?: string; text?: string; routineId?: string; revision?: string | number; schedule?: HomeTeamRoutine['schedule']; allowedActions?: HomeTeamRoutine['allowedActions']; limits?: HomeTeamRoutine['limits']; wakeProtectionEnabled?: boolean };
type HostFixture = Omit<typeof host, 'coordinator' | 'teamWork'> & { coordinator: Omit<typeof host.coordinator, 'enabled'> & { enabled: boolean | null }; teamWork?: typeof host.teamWork };
type BridgeResult = HostFixture | HomeTeamRun | HomeTeamRoutine | typeof teammate | Array<{ id: string; label: string }>
    | Array<{ teammate: typeof teammate; unread: boolean; latestRun: Omit<HomeTeamRun, 'usage'> & { usage?: HomeTeamRun['usage'] } }>
    | { teammate: typeof teammate; runs: HomeTeamRun[]; routines: HomeTeamRoutine[] }
    | { code: string; message: string; at: number };
function installDom(invoke: (command: string, args: BridgeInput) => Promise<BridgeResult>) {
    const dom = new Window({ url: 'http://localhost' });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    const globals = {
        window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
        Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, HTMLTextAreaElement: dom.HTMLTextAreaElement, Node: dom.Node,
        customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet, Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent,
        MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
        requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [name, value] of Object.entries(globals)) {
        originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    Object.defineProperty(dom, '__OPENCHAMBER_ELECTRON__', { configurable: true, value: { runtime: 'electron' } });
    Object.defineProperty(dom, '__OPENCHAMBER_DESKTOP__', { value: { invoke } });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => new Promise<Response>(() => {}), previousFetch);
    return { dom, restore() {
        globalThis.fetch = previousFetch;
        dom.happyDOM.cancelAsync();
        for (const [name, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    } };
}

test('team inbox scopes content, retains identity/history/drafts and confirms exact routine revisions', async () => {
    let routine = proposal;
    let sends = 0;
    let failSend = true;
    let failDetails = false;
    let available = true;
    const requests: string[] = [];
    const confirmations: BridgeInput[] = [];
    const proposals: BridgeInput[] = [];
    let staleConfirmation = true;
    let readRevision = 0;
    const acknowledgements: BridgeInput[] = [];
    let runs = [failedRun, completedRun];
    const harness = installDom(async (command, args) => {
        if (command === 'desktop_ai_host_status') return host;
        if (args.action === 'ai-projects') return [{ id: 'research', label: 'Research' }, { id: 'legal', label: 'Legal' }];
        if (!available) return { code: 'team_runtime_unavailable', message: 'Team runtime is not available on this host', at: 1 };
        if (args.action === 'team-inbox') return [{ teammate: { ...teammate, readRevision }, unread: teammate.revision > readRevision, latestRun: completedRun }, { teammate: { ...teammate, id: 'manager-legal', projectId: 'legal', projectLabel: 'Legal' }, unread: false, latestRun: { ...completedRun, projectId: 'legal', teammateId: 'manager-legal', title: 'Sensitive legal content' } }];
        if (args.action === 'team-details') {
            if (failDetails) throw new Error('Could not refresh this project.');
            return { teammate, runs, routines: [routine] };
        }
        if (args.action === 'team-send') {
            sends++; requests.push(args.requestId ?? '');
            if (failSend) throw new Error('Dispatch response lost. Inspect before retrying.');
            const run = { ...completedRun, id: 'new-run', taskId: 'new-task', text: args.text ?? '', failure: undefined };
            runs = [...runs, run];
            return run;
        }
        if (args.action === 'team-propose-routine') { proposals.push(args); return routine; }
        if (args.action === 'team-ack') { acknowledgements.push(args); readRevision = Number(args.revision); return { ...teammate, readRevision }; }
        if (args.action === 'team-confirm-routine') { confirmations.push(args); if (staleConfirmation) throw new Error('Routine revision changed. Review again.'); routine = { ...routine, status: 'confirmed', revision: 'confirmed-v2', nextRunAt: 1791900000000 }; return routine; }
        if (args.action === 'team-pause-routine') { confirmations.push(args); routine = { ...routine, status: 'paused', revision: 'paused-v3', nextRunAt: undefined }; return routine; }
        throw new Error(`Unexpected test action: ${args.action}`);
    });
    const { createRoot } = await import('react-dom/client');
    const { I18nProvider } = await import('@/lib/i18n');
    const { HomeTeamInbox } = await import('./HomeTeamInbox');
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    const button = (label: string) => {
        const found = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
        if (!found) throw new Error(`Missing button: ${label}`);
        return found;
    };
    const render = (active = true) => root.render(<I18nProvider><HomeTeamInbox active={active} /></I18nProvider>);
    const messageField = () => {
        const input = document.querySelector('textarea');
        if (!(input instanceof HTMLTextAreaElement)) throw new Error('Missing message field');
        return input;
    };
    const chooseProject = async (name: string) => {
        const trigger = document.querySelector('button[aria-label="Project folder"]');
        if (!(trigger instanceof HTMLElement)) throw new Error('Missing project selector');
        await act(async () => trigger.click());
        const option = [...document.querySelectorAll('[data-slot="select-content"]:not([data-closed]) [role="option"]')].reverse().find((item) => item.textContent === name);
        if (!(option instanceof HTMLElement)) throw new Error(`Missing project option: ${name}`);
        await act(async () => { option.focus(); option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
        await act(async () => {
            option.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 }));
            option.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0 }));
            option.click();
        });
        expect(trigger.textContent).toContain(name);
    };
    try {
        await act(async () => render());
        expect(container.textContent).not.toContain('Sensitive legal content');
        expect(container.textContent).not.toContain('Completed assignment');
        await chooseProject('Research');
        expect(container.textContent).not.toContain('Sensitive legal content');
        expect(container.textContent).toContain('Failed assignment');
        expect(container.textContent).toContain('No chat linked');
        expect(container.textContent).toContain('Chat creation failed');
        expect(container.textContent).toContain('Saved result remains readable');
        expect(container.textContent).toContain('Child history or evidence could not be refreshed');
        expect(container.textContent).toContain('Actual direct child');
        const { useSessionUIStore } = await import('@/sync/session-ui-store');
        await act(async () => button('Actual direct child').click());
        expect(useSessionUIStore.getState().currentSessionId).toBe('ses_child');
        expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/projects/research');
        await act(async () => button('Source message').click());
        expect(location.hash).toBe('#search-message-msg_result');
        await act(async () => button('Open chat').click());
        expect(useSessionUIStore.getState().currentSessionId).toBe('ses_parent');
        expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/projects/research');
        expect(location.hash).toBe('');
        await act(async () => button('Mark read').click());
        expect(acknowledgements[0]).toMatchObject({ projectId: 'research', teammateId: teammate.id, revision: 3 });
        expect(container.textContent).not.toContain('Unread update');
        expect(container.textContent).toContain('not a hard dollar cap');
        expect(container.textContent).toContain('100,000 per project');
        expect(container.textContent).toContain('250,000 across the team');
        expect(container.textContent).toContain('Pickups paused');
        expect(container.textContent).toContain('Team work active or scheduled');
        expect(container.textContent).toContain('Proposed, not scheduled');
        expect(confirmations).toHaveLength(0);
        let input = messageField();
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (!setter || !inputSetter) throw new Error('Missing input setters');
        await act(async () => { setter.call(input, 'Review this weekly'); input.dispatchEvent(new Event('input', { bubbles: true })); });
        expect(proposals).toHaveLength(0);
        await act(async () => button('Mon').click());
        for (const [label, value] of [['Time', '09:00'], ['Maximum occurrences', '4'], ['Observed token guardrail', '10000']]) {
            const field = document.querySelector(`input[aria-label="${label}"]`);
            if (!(field instanceof HTMLInputElement)) throw new Error(`Missing routine field: ${label}`);
            await act(async () => { inputSetter.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
        }
        await act(async () => button('Review as a routine').click());
        expect(proposals[0]).toMatchObject({ projectId: 'research', allowedActions: ['read-project'], limits: { maxOccurrences: 4, tokenGuardrail: 10000 }, schedule: { kind: 'weekly', weekdays: [1], time: '09:00' } });
        expect(sends).toBe(0);
        await act(async () => button('Confirm routine').click());
        expect(confirmations[0]).toMatchObject({ action: 'team-confirm-routine', projectId: 'research', routineId: 'routine', revision: 'proposal-v1' });
        expect(container.textContent).toContain('Routine revision changed');
        expect(container.textContent).not.toContain('Next run:');
        staleConfirmation = false;
        await act(async () => button('Confirm routine').click());
        expect(container.textContent).toContain('Next run:');
        await act(async () => button('Pause').click());
        expect(confirmations[2]).toMatchObject({ action: 'team-pause-routine', revision: 'confirmed-v2' });
        expect(container.textContent).not.toContain('Next run:');
        await act(async () => { setter.call(input, 'Keep my draft'); input.dispatchEvent(new Event('input', { bubbles: true })); });
        await act(async () => button('Send assignment').click());
        expect(input.value).toBe('Keep my draft');
        expect(container.textContent).toContain('Inspect before retrying');
        failSend = false;
        await act(async () => button('Send assignment').click());
        expect(requests[0]).toBe(requests[1]);
        expect(sends).toBe(2);
        expect(input.value).toBe('');
        expect(container.querySelectorAll('div.my-3')).toHaveLength(1);
        expect(container.textContent).toContain('new-task');
        await act(async () => { setter.call(input, 'Unsent revision'); input.dispatchEvent(new Event('input', { bubbles: true })); });
        await chooseProject('Legal');
        input = messageField();
        expect(input.value).toBe('');
        expect(container.textContent).not.toContain('Saved result remains readable');
        await chooseProject('Research');
        input = messageField();
        expect(input.value).toBe('Unsent revision');
        await act(async () => render(false));
        await act(async () => render(true));
        expect(input.value).toBe('Unsent revision');
        failDetails = true;
        await act(async () => button('Refresh').click());
        expect(container.textContent).toContain('Could not refresh this project');
        expect(container.textContent).toContain('Saved result remains readable');
        available = false;
        await act(async () => button('Refresh').click());
        expect(button('Send assignment').disabled).toBe(true);
        expect(input.value).toBe('Unsent revision');
        expect(container.textContent).toContain('Team runtime is not available');
        Object.defineProperty(harness.dom, '__OPENCHAMBER_ELECTRON__', { value: { runtime: 'web' } });
        await act(async () => render());
        expect(container.textContent).toContain('desktop');
        expect(container.querySelector('textarea')).toBeNull();
    } finally { await act(async () => root.unmount()); harness.restore(); }
});

test('client parsers reject mismatched ownership and malformed contracts without empty success', async () => {
    let mismatch = false;
    let missingUsage = false;
    const harness = installDom(async (_command, args) => {
        if (args.action === 'team-details') return { teammate: { ...teammate, projectId: mismatch ? 'legal' : 'research' }, runs: [failedRun], routines: [] };
        if (args.action === 'team-inbox') return [{ teammate, unread: true, latestRun: { ...failedRun, usage: missingUsage ? undefined : usage } }];
        return { code: 'team_runtime_unavailable', message: 'Unavailable host', at: 1 };
    });
    try {
        const { readTeamDetails, readTeamInbox, sendTeamMessage, TeamRuntimeUnavailableError } = await import('@/lib/personal-home');
        const first = await readTeamDetails('research', teammate.id);
        expect(first.runs[0]?.sessionId).toBeUndefined();
        expect(first.runs[0]?.failure?.stage).toBe('create');
        mismatch = true;
        await expect(readTeamDetails('research', teammate.id)).rejects.toThrow();
        missingUsage = true;
        await expect(readTeamInbox()).rejects.toThrow();
        await expect(sendTeamMessage({ projectId: 'research', title: 'Never dispatched', text: 'test', requestId: 'request' })).rejects.toThrow(TeamRuntimeUnavailableError);
    } finally { harness.restore(); }
});

test('initial loading and failed inbox reads are not an empty successful team', async () => {
    let rejectInbox: (error: Error) => void = (error) => { throw error; };
    const pending = new Promise<BridgeResult>((_resolve, reject) => { rejectInbox = reject; });
    let reads = 0;
    const harness = installDom(async (command, args) => {
        if (command === 'desktop_ai_host_status') return host;
        if (args.action === 'ai-projects') return [{ id: 'research', label: 'Research' }];
        reads++;
        return pending;
    });
    const { createRoot } = await import('react-dom/client');
    const { I18nProvider } = await import('@/lib/i18n');
    const { HomeTeamInbox } = await import('./HomeTeamInbox');
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () => root.render(<I18nProvider><HomeTeamInbox /></I18nProvider>));
        expect(container.textContent).toContain('Loading');
        expect(container.textContent).not.toContain('No assignments yet');
        await act(async () => rejectInbox(new Error('Host storage read failed.')));
        expect(container.textContent).toContain('Host storage read failed');
        expect(container.textContent).toContain('Unavailable');
        expect(container.textContent).not.toContain('No assignments yet');
        expect(reads).toBe(1);
        await act(async () => root.render(<I18nProvider><HomeTeamInbox active={false} /></I18nProvider>));
        expect(reads).toBe(1);
    } finally { await act(async () => root.unmount()); harness.restore(); }
});

test('native host contracts distinguish unavailable from paused and reject unsupported client operations', async () => {
    let calls = 0;
    let malformed = false;
    let missingTeamWork = false;
    let configured: boolean | undefined;
    const harness = installDom(async (command, args) => {
        calls++;
        if (command === 'desktop_ai_host_configure') configured = args.wakeProtectionEnabled;
        return { ...host, teamWork: missingTeamWork ? undefined : host.teamWork, coordinator: { ...host.coordinator, state: 'unavailable', enabled: null }, wakeProtection: { ...host.wakeProtection, reason: malformed ? 'invented-state' : 'coordinator_unavailable' } };
    });
    try {
        const { readAiHostStatus, configureAiHost } = await import('@/lib/personal-home');
        const status = await readAiHostStatus();
        expect(status.coordinator.state).toBe('unavailable');
        expect(status.teamWork.state).toBe('required');
        await configureAiHost(true);
        expect(configured).toBe(true);
        malformed = true;
        await expect(readAiHostStatus()).rejects.toThrow();
        malformed = false; missingTeamWork = true;
        await expect(readAiHostStatus()).rejects.toThrow();
        Object.defineProperty(harness.dom, '__OPENCHAMBER_ELECTRON__', { value: { runtime: 'web' } });
        const previousCalls = calls;
        await expect(readAiHostStatus()).rejects.toThrow('Local host controls require the desktop app.');
        await expect(configureAiHost(true)).rejects.toThrow('Local host controls require the desktop app.');
        expect(calls).toBe(previousCalls);
    } finally { harness.restore(); }
});

test('team drafts survive remounts with retry identity and remain isolated by runtime, project and run', async () => {
    const harness = installDom(async () => host);
    try {
        const { readTeamDraft, writeTeamDraft, reviseTeamRun } = await import('@/lib/personal-home');
        const draft = { text: 'Keep this draft', requestId: crypto.randomUUID() };
        writeTeamDraft('local', 'research', draft);
        expect(readTeamDraft('local', 'research')).toEqual(draft);
        expect(readTeamDraft('remote', 'research')).toBeNull();
        expect(readTeamDraft('local', 'legal')).toBeNull();
        expect(readTeamDraft('local', 'research', 'completed')).toBeNull();
        const revision = { ...draft, revision: 3 };
        writeTeamDraft('local', 'research', revision, 'completed');
        expect(readTeamDraft('local', 'research', 'completed')).toEqual(revision);
        writeTeamDraft('local', 'research', null);
        expect(readTeamDraft('local', 'research')).toBeNull();
        expect(readTeamDraft('local', 'research', 'completed')).toEqual(revision);
        const key = [...Array(localStorage.length)].map((_, index) => localStorage.key(index)).find((item) => item?.includes('completed'));
        if (!key) throw new Error('Missing saved draft');
        localStorage.setItem(key, '{"text":false}');
        expect(() => readTeamDraft('local', 'research', 'completed')).toThrow();
        // A host response of the wrong shape is not a successful revision.
        await expect(reviseTeamRun({ projectId: 'research', runId: 'completed', revision: 1, text: 'Revise', requestId: draft.requestId })).rejects.toThrow();
    } finally { harness.restore(); }
});

test('tracked revision keeps retry identity across remount and file previews stay separate from source evidence', async () => {
    const revisions: BridgeInput[] = [];
    const harness = installDom(async (_command, args) => {
        if (args.action !== 'team-revise') throw new Error('Unexpected revision operation');
        revisions.push(args);
        if (revisions.length === 1) throw new Error('Revision response lost');
        return { ...completedRun, id: 'revised', failure: undefined, revisionOf: args.runId, sourceRevision: Number(args.revision) };
    });
    const { createRoot } = await import('react-dom/client');
    const { I18nProvider } = await import('@/lib/i18n');
    const { HomeTeamRunDetails } = await import('./HomeTeamRunDetails');
    const { reviseTeamRun, readTeamDraft } = await import('@/lib/personal-home');
    const { useUIStore } = await import('@/stores/useUIStore');
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    const run = { ...completedRun, artifacts: [...completedRun.artifacts, ...['../secret.txt', 'https://example.com/report', '/other/project/report.md'].map((path) => ({ path, label: path, sessionId: 'ses_child', messageId: 'msg_result' }))] };
    let error = '';
    const render = (key: string) => root.render(<I18nProvider><HomeTeamRunDetails key={key} runtime="local" run={run} disabled={false} onPause={() => {}} onRecover={() => {}} onRevise={(input, onSaved) => {
        void reviseTeamRun(input).then(() => onSaved()).catch((failure: Error) => { error = failure.message; });
    }} /></I18nProvider>);
    const field = () => {
        const input = container.querySelector('textarea');
        if (!(input instanceof HTMLTextAreaElement)) throw new Error('Missing revision field');
        return input;
    };
    const button = (label: string) => {
        const found = [...container.querySelectorAll('button')].find((item) => item.textContent === label);
        if (!found) throw new Error(`Missing ${label}`);
        return found;
    };
    try {
        await act(async () => render('first'));
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (!setter) throw new Error('Missing textarea setter');
        await act(async () => { setter.call(field(), 'Add citations'); field().dispatchEvent(new Event('input', { bubbles: true })); });
        await act(async () => button('Send tracked revision').click());
        expect(error).toBe('Revision response lost');
        expect(field().value).toBe('Add citations');
        await act(async () => render('remount'));
        expect(field().value).toBe('Add citations');
        await act(async () => button('Send tracked revision').click());
        expect(revisions).toHaveLength(2);
        expect(revisions[1]).toEqual(revisions[0]);
        expect(revisions[0]).toMatchObject({ action: 'team-revise', projectId: 'research', runId: 'completed', revision: 1, text: 'Add citations' });
        expect(field().value).toBe('');
        expect(readTeamDraft('local', 'research', 'completed')).toBeNull();
        const fileButtons = [...container.querySelectorAll('button')].filter((item) => item.textContent === 'Open file');
        expect(fileButtons.map((item) => item.disabled)).toEqual([false, true, true, true]);
        await act(async () => fileButtons[0].click());
        expect(useUIStore.getState().pendingFileFocusPath).toBe('/projects/research/result.md');
        expect(location.hash).toBe('');
        await act(async () => button('Source message').click());
        expect(location.hash).toBe('#search-message-msg_result');
    } finally { await act(async () => root.unmount()); harness.restore(); }
});

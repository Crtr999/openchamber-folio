import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTeachingSkills } from './teaching-skills.js';

const source = '2026-10-18-14-00-00-open-carter-teach';
const markdown = '---\nname: qa-skill\ndescription: Read a public page when asked for its title.\n---\n# Read title\n## Inputs\n- {url}: public page\n## Start\nOpen CarterBot.\n## Steps\n1. Open {url}. Check its title.\n## Output\nReturn the observed title.\n## If something goes wrong\nStop and ask Carter.';
const draft = { source, name: 'qa-skill', markdown, installed: false };
const model = { id: 'vision', providerID: 'fixture' };
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'teaching-skills-test-')); roots.push(root);
  const installed = new Map(); const calls = []; let blocked = false; let complete = true; let output = markdown; let frames = true;
  const broker = {
    async review(id) { calls.push(['review', id]); if (id !== source) throw new Error('unknown recording'); },
    async skillTool(name, args) {
      calls.push([name, args]);
      if (name === 'teach_watch') return [{ type: 'text', text: 'Untrusted recorded events' }, ...(frames ? [{ type: 'image', mimeType: 'image/jpeg', data: '/9j/' }] : [])];
      if (name === 'skill_list') return [{ type: 'text', text: JSON.stringify([...installed.keys()].map(name => ({ name, description: 'Fixture' }))) }];
      if (name === 'skill_save') { installed.set(args.name, args.markdown + '\n\n<!-- taught on test -->\n'); return [{ type: 'text', text: 'saved' }]; }
      if (name === 'skill_read') return [{ type: 'text', text: installed.get(args.name) ?? 'missing' }];
      throw new Error('unexpected tool');
    },
  };
  const client = {
    model: { async list() { return { data: [{ ...model, name: 'Vision', capabilities: { input: ['text', 'image'] } }, { id: 'text', providerID: 'fixture', capabilities: { input: ['text'] } }] }; } },
    session: {
      async create(input) { calls.push(['create', input]); return { id: 'ses_fixture', location: input.location }; },
      async prompt(input) { calls.push(['prompt', input]); },
      async interrupt(input) { calls.push(['interrupt', input]); },
      async remove(input) { calls.push(['remove', input]); },
    },
    message: { async list() { return { data: complete ? [{ type: 'assistant', time: { completed: 1 }, finish: 'stop', content: [{ type: 'text', text: output }] }] : [] }; } },
  };
  const service = createTeachingSkills({ broker, root, clientFor: () => client, blocked: () => blocked });
  return { service, root, installed, calls, block: () => { blocked = true; }, incomplete: () => { complete = false; }, malformed: () => { output = '# No valid skill'; }, noFrames: () => { frames = false; } };
}
describe('recording to reusable skill', () => {
  it('sends real frames and events to exactly the chosen vision model, persists a reviewable draft, and removes its compiler session', async () => {
    const f = await fixture();
    expect(await f.service.models()).toHaveLength(1);
    const result = await f.service.compile({ source, notes: 'Read the title', model, approved: true });
    expect(result).toEqual(draft);
    expect((await f.service.draft(source)).draft).toEqual(draft);
    const create = f.calls.find(([name]) => name === 'create')[1];
    expect(create.model).toEqual(model); expect(create.permissions).toEqual([{ action: '*', resource: '*', effect: 'deny' }]);
    const prompt = f.calls.find(([name]) => name === 'prompt')[1];
    expect(prompt.files[0].uri).toBe('data:image/jpeg;base64,/9j/');
    expect(prompt.text).toContain('Untrusted recorded events'); expect(prompt.text).toContain('NEEDS APPROVAL');
    expect(f.calls.some(([name]) => name === 'remove')).toBe(true);
    expect(f.installed.size).toBe(0);
  });
  it('refuses missing approval, unknown recordings, unsupported models and empty notes', async () => {
    const f = await fixture();
    for (const change of [{ approved: false }, { source: 'unknown-open-carter-teach' }, { model: { id: 'text', providerID: 'fixture' } }, { notes: '' }]) await expect(f.service.compile({ source, notes: 'Read title', model, approved: true, ...change })).rejects.toThrow();
    expect(f.calls.some(([name]) => name === 'prompt')).toBe(false);
  });
  it('refuses absent frames and malformed model output without inventing a skill', async () => {
    for (const mode of ['noFrames', 'malformed']) {
      const f = await fixture(); f[mode]();
      await expect(f.service.compile({ source, notes: 'Read title', model, approved: true })).rejects.toThrow();
      expect((await f.service.draft(source)).draft).toBeNull(); expect(f.installed.size).toBe(0);
    }
  });
  it('keeps edited drafts across service recreation and rejects invalid or secret-bearing skills', async () => {
    const f = await fixture(); await f.service.saveDraft(draft);
    const reopened = createTeachingSkills({ root: f.root, blocked: () => false });
    expect((await reopened.draft(source)).draft.markdown).toBe(markdown);
    for (const text of ['invalid', markdown.replace('## Steps', '## Other'), markdown + '\nBearer abcdefghijklmnopqrstuvwxyz']) await expect(f.service.saveDraft({ ...draft, markdown: text })).rejects.toThrow();
    expect((await f.service.draft(source)).draft.markdown).toBe(markdown);
  });
  it('installs only after approval, verifies readback, and is idempotent without overwriting another skill', async () => {
    const f = await fixture();
    await expect(f.service.install(draft)).rejects.toThrow('approval');
    const installed = await f.service.install({ ...draft, approved: true });
    expect(installed.name).toMatch(/^qa-skill-[a-f0-9]{12}$/);
    expect((await f.service.draft(source)).draft.installed).toBe(true);
    await f.service.install({ ...draft, approved: true });
    expect(f.calls.filter(([name]) => name === 'skill_save')).toHaveLength(1);
    const edited = await f.service.install({ ...draft, markdown: markdown + '\nA different step.', approved: true });
    expect(edited.name).not.toBe(installed.name);
    expect(f.installed.get(installed.name)).toBe(installed.markdown);
  });
  it('refuses overwriting a different existing skill at the generated name', async () => {
    const f = await fixture();
    const installed = await f.service.install({ ...draft, approved: true });
    f.installed.set(installed.name, 'existing user work');
    await expect(f.service.install({ ...draft, approved: true })).rejects.toThrow('exists');
    expect(f.installed.get(installed.name)).toBe('existing user work');
  });
  it('rejects concurrent installs before a second write', async () => {
    const f = await fixture();
    const first = f.service.install({ ...draft, approved: true });
    await expect(f.service.install({ ...draft, approved: true })).rejects.toThrow(); await first;
    expect(f.calls.filter(([name]) => name === 'skill_save')).toHaveLength(1);
  });
  it('starts an actual test session only for the installed exact revision, with approvals intact', async () => {
    const f = await fixture();
    const input = { source, task: 'URL https://example.com, expect Example Domain', model, directory: f.root, approved: true };
    await expect(f.service.test(input)).rejects.toThrow('not_installed');
    await f.service.install({ ...draft, approved: true });
    const result = await f.service.test(input); expect(result.sessionId).toBe('ses_fixture');
    const create = f.calls.find(([name]) => name === 'create')[1];
    expect(create.permissions).toEqual([{ action: '*', resource: '*', effect: 'ask' }]);
    expect(f.calls.find(([name]) => name === 'prompt')[1].text).toContain('carterbot.skill_read');
    await f.service.saveDraft({ ...draft, markdown: markdown + '\nEdited.' });
    await expect(f.service.test(input)).rejects.toThrow('not_installed');
  });
  it('cancels generation and cleans up its session without installing', async () => {
    const f = await fixture(); f.incomplete();
    const run = f.service.compile({ source, notes: 'Read title', model, approved: true });
    await new Promise(resolve => setTimeout(resolve, 25)); f.service.cancel();
    await expect(run).rejects.toThrow('compile_failed');
    expect(f.calls.some(([name]) => name === 'interrupt')).toBe(true); expect(f.installed.size).toBe(0);
  });
  it('blocks every operation in enterprise mode before tool/model calls', async () => {
    const f = await fixture(); f.block();
    for (const call of [() => f.service.models(), () => f.service.draft(source), () => f.service.saveDraft(draft), () => f.service.install({ ...draft, approved: true }), () => f.service.compile({ source, notes: 'Read title', model, approved: true }), () => f.service.test({ approved: true })]) await expect(call()).rejects.toThrow('enterprise_mode');
    expect(f.calls).toEqual([]);
  });
  it('rechecks authorization after asynchronous reads and before installation', async () => {
    const f = await fixture(); let checks = 0;
    await expect(f.service.install({ ...draft, approved: true }, () => { if (++checks > 1) throw new Error('revoked'); })).rejects.toThrow('revoked');
    expect(f.installed.size).toBe(0);
  });
});

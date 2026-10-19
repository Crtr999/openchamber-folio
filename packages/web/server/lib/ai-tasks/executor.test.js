import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAiTaskExecutor } from './executor.js';

describe('manager brief', () => {
  let directory;
  afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
  const send = async () => {
    const prompt = vi.fn(async () => {});
    const executor = createAiTaskExecutor({ readProjects: async () => [], getClient: () => ({ session: { prompt } }) });
    await executor.send({ directory, sessionId: 'ses_1', title: 'Plan' }, 'Notes');
    return prompt.mock.calls[0][0].text;
  };

  it('inlines project rules so the manager need not stop for a read approval', async () => {
    directory = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'brief-')));
    await writeFile(path.join(directory, 'AGENTS.md'), 'Answer in Spanish.\n');
    const text = await send();
    expect(text).toContain('--- AGENTS.md ---\nAnswer in Spanish.\n--- end AGENTS.md ---');
    expect(text).not.toContain('MEMORY.md ---');
    expect(text.endsWith('Task title: Plan\n\nTask page:\nNotes')).toBe(true);
    expect(text).toContain('explicit acceptance checklist');
    expect(text).toContain('Send deficient work back');
    expect(text).toContain('attachment was not supplied or successfully read');
    expect(text).toContain('existing agent steps, permissions, token caps and deadline');
  });

  it('does not follow a symlinked rule file and tells the manager to read it', async () => {
    directory = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'brief-')));
    await mkdir(path.join(directory, 'elsewhere'));
    await writeFile(path.join(directory, 'elsewhere/secret.md'), 'secret');
    await symlink(path.join(directory, 'elsewhere/secret.md'), path.join(directory, 'MEMORY.md'));
    const text = await send();
    expect(text).not.toContain('secret');
    expect(text).toContain('MEMORY.md could not be included; read it before starting.');
  });
});

describe('completion review evidence', () => {
  const directory = '/project';
  const contract = 'Completion contract: ai-task-review-v1.';
  const assistant = (id, text) => ({ id, type: 'assistant', time: { completed: 100 }, finish: 'stop', content: [{ type: 'text', text }] });
  const review = (references = [], files = []) => ({ checks: [{ criterion: 'Deliver requested analysis', finding: 'Checked coverage and stated assumptions against the requested scope.',
    evidence: references.map(({ sessionId, messageId }) => ({ sessionId, quote: messageId === 'child-final' ? 'The specialist analysis includes evidence' : messageId === 'final' ? 'The requested analysis is included here' : 'Actually opened reference content.' })),
  }], files, limitations: [] });
  const answer = data => `DONE\nThe requested analysis is included here with its assumptions, findings and practical next steps.\n\n\`\`\`ai-task-review\n${JSON.stringify(data)}\n\`\`\``;
  const fixture = (text, extra = {}) => {
    const records = { parent: [assistant('final', text)], child: [assistant('child-final', 'The specialist analysis includes evidence and explicit caveats.')], ...extra };
    const get = vi.fn(async ({ sessionID }) => ({ id: sessionID, location: { directory }, outcome: 'succeeded' }));
    const active = vi.fn(async () => ({}));
    const list = vi.fn(async ({ sessionID }) => ({ data: records[sessionID] ?? [], cursor: { next: null } }));
    const executor = createAiTaskExecutor({ readProjects: async () => [], getClient: () => ({ session: { get, active }, message: { list } }) });
    const run = { directory, sessionId: 'parent', savedContext: contract, children: [], artifacts: [] };
    return { executor, run, records, get, list, active };
  };
  it('keeps historical answers compatible but refuses bare DONE on new runs', async () => {
    const f = fixture('DONE');
    expect((await f.executor.inspect({ ...f.run, savedContext: undefined })).kind).toBe('done');
    expect((await f.executor.inspect(f.run)).kind).toBe('needs-you');
  });
  it('accepts a substantive inline deliverable with an explicit self-review', async () => {
    const f = fixture(answer(review()));
    expect(await f.executor.inspect(f.run)).toMatchObject({ kind: 'done', reviewEvidence: 'verified' });
  });
  it('accepts v2 reasoning state without treating it as tool state', async () => {
    const f = fixture(answer(review()));
    f.records.parent[0].content.unshift({ type: 'reasoning', text: 'Private reasoning', state: { provider: 'opaque' } });
    expect((await f.executor.inspect(f.run)).kind).toBe('done');
    f.records.parent.push({ id: 'old', type: 'assistant', time: { completed: 1 }, content: [{ type: 'reasoning', state: {} }] });
    expect((await f.executor.inspect(f.run)).kind).toBe('done');
  });
  it('still refuses malformed tool state rather than accepting it as opaque reasoning', async () => {
    const f = fixture(answer(review()));
    f.records.parent[0].content.push({ type: 'tool', state: {} });
    await expect(f.executor.inspect(f.run)).rejects.toThrow();
  });
  const independent = () => {
    const draft = 'Private draft with specific claims and inline source citations.';
    const confirmation = 'Confirmed the draft coverage and each claim citation after independent source inspection.';
    const data = { checks: [{ criterion: 'Deliver requested analysis', finding: 'Independently checked the actual draft and its source claims.', evidence: [{ sessionId: 'child', quote: confirmation }] }], files: [], limitations: [],
      audit: { draft: { sessionId: 'parent', quote: draft }, reviewerSessionId: 'child', verdicts: [{ criterion: 'Deliver requested analysis', verdict: 'confirmed', evidence: { sessionId: 'child', quote: confirmation } }], corrections: [] } };
    const f = fixture(answer(data), { child: [assistant('child-final', confirmation), { id: 'review-request', type: 'user', text: `Independently review: Deliver requested analysis\n${draft}` }] });
    f.records.parent.push(assistant('draft', draft));
    f.run.savedContext = 'Completion contract: ai-task-review-v2.';
    f.run.children = [{ id: 'child', directory, title: 'Independent reviewer' }];
    return { ...f, data, confirmation };
  };
  it('requires a real separate reviewer and final criterion confirmations for new runs', async () => {
    const f = independent();
    expect((await f.executor.inspect(f.run)).kind).toBe('done');
    f.run.children = [];
    expect((await f.executor.inspect(f.run)).kind).toBe('needs-you');
    const self = fixture(answer(review()));
    expect((await self.executor.inspect({ ...self.run, savedContext: 'Completion contract: ai-task-review-v2.' })).kind).toBe('needs-you');
  });
  it.each(['author', 'missing-criterion', 'old-confirmation', 'invented-correction'])('refuses %s adversarial review evidence', async mode => {
    const f = independent();
    if (mode === 'author') f.data.audit.draft.sessionId = 'child';
    if (mode === 'missing-criterion') f.data.audit.verdicts[0].criterion = 'A different requirement';
    if (mode === 'old-confirmation') f.records.child.unshift(assistant('new', 'New final review has unresolved defects and does not confirm completion.'));
    if (mode === 'invented-correction') f.data.audit.corrections.push({ objection: { sessionId: 'child', quote: 'An invented unsupported objection.' }, response: { sessionId: 'parent', quote: 'An invented correction with no evidence.' }, resolution: { sessionId: 'child', quote: f.confirmation } });
    f.records.parent[0] = assistant('final', answer(f.data));
    expect((await f.executor.inspect(f.run)).kind).toBe('needs-you');
  });
  it('requires observed objection, author correction and final reviewer resolution', async () => {
    const f = independent();
    const objection = 'The draft overstates the source and omits its limiting exception.';
    const correction = 'Revised the claim to include the limiting exception in the source.';
    f.records.child.push(assistant('objection', objection));
    f.records.child[1].text += `\n${objection}\n${correction}`;
    f.records.parent.push(assistant('correction', correction));
    f.data.audit.corrections.push({ objection: { sessionId: 'child', quote: objection }, response: { sessionId: 'parent', quote: correction }, resolution: { sessionId: 'child', quote: f.confirmation } });
    f.records.parent[0] = assistant('final', answer(f.data));
    expect((await f.executor.inspect(f.run)).kind).toBe('done');
    f.records.parent.pop();
    expect((await f.executor.inspect(f.run)).kind).toBe('needs-you');
  });
  it.each(['unrelated-request', 'draft-after-review', 'unconfirmed'])('refuses %s even with genuine reviewer excerpts', async mode => {
    const f = independent();
    if (mode === 'unrelated-request') f.records.child[1].text = 'Review some unrelated work.';
    if (mode === 'draft-after-review') f.records.parent[1].time.completed = 200;
    if (mode === 'unconfirmed') {
      f.data.audit.verdicts[0].verdict = 'overreach';
      f.records.parent[0] = assistant('final', answer(f.data));
    }
    expect((await f.executor.inspect(f.run)).kind).toBe('needs-you');
  });
  it('allows an explicitly superseded failed attempt only after fresh replacement review', async () => {
    const f = independent();
    f.run.children.push({ id: 'abandoned', directory, title: 'Failed draft attempt' });
    f.get.mockImplementation(async ({ sessionID }) => ({ id: sessionID, location: { directory }, outcome: sessionID === 'abandoned' ? 'failed' : 'succeeded' }));
    expect((await f.executor.inspect(f.run)).kind).toBe('needs-you');
    const confirmation = 'Confirmed replacement of abandoned after checking the corrected draft and all source claims.';
    f.records.child[0].content[0].text += '\n' + confirmation;
    f.records.child[1].text += '\nReplace abandoned using the corrected draft above.';
    f.data.audit.superseded = [{ sessionId: 'abandoned', reason: 'Failed earlier attempt omitted the source qualifications.', replacement: f.data.audit.draft, confirmation: { sessionId: 'child', quote: confirmation } }];
    f.records.parent[0] = assistant('final', answer(f.data));
    expect((await f.executor.inspect(f.run)).kind).toBe('done');
    f.active.mockResolvedValue({ abandoned: { type: 'busy' } });
    expect((await f.executor.inspect(f.run)).kind).toBe('needs-you');
    f.active.mockResolvedValue({});
    f.data.audit.superseded[0].confirmation.quote = 'Invented replacement confirmation for abandoned.';
    f.records.parent[0] = assistant('final', answer(f.data));
    expect((await f.executor.inspect(f.run)).kind).toBe('needs-you');
  });
  it('supports pushback from an earlier reviewer followed by fresh independent correction review', async () => {
    const f = independent();
    const objection = 'The previous draft overstates the cited source and must be narrowed.';
    const response = 'The corrected draft narrows the claim to the source supported conclusion.';
    f.run.children.push({ id: 'first-reviewer', directory, title: 'First review' });
    f.records['first-reviewer'] = [assistant('first-final', objection)];
    f.records.parent.push(assistant('corrected-draft', response));
    f.data.checks[0].evidence.push({ sessionId: 'first-reviewer', quote: objection });
    f.data.audit.corrections.push({ objection: { sessionId: 'first-reviewer', quote: objection }, response: { sessionId: 'parent', quote: response }, resolution: { sessionId: 'child', quote: f.confirmation } });
    f.records.child[1].text += `\n${objection}\n${response}`;
    f.records.parent[0] = assistant('final', answer(f.data));
    expect((await f.executor.inspect(f.run)).kind).toBe('done');
    f.records.child[1].text = 'Reviewed only an unrelated draft.';
    expect((await f.executor.inspect(f.run)).kind).toBe('needs-you');
  });
  it.each(['DONE\n```ai-task-review\n{}\n```', answer(review()) + '\n```ai-task-review\n{}\n```', answer(review()) + '\nExtra trailing claims.'])('refuses malformed, duplicate or nonfinal review blocks', async text => {
    const f = fixture(text);
    expect((await f.executor.inspect(f.run)).kind).toBe('needs-you');
  });
  it.each(['unknown', 'parent'])('refuses invented or self-referential evidence from %s', async sessionId => {
    const f = fixture(answer(review([{ sessionId, messageId: 'final' }])));
    expect((await f.executor.inspect(f.run)).kind).toBe('needs-you');
  });
  it('requires every actual child final output, not an earlier progress summary', async () => {
    const f = fixture(answer(review()));
    f.run.children = [{ id: 'child', directory, title: 'Analysis' }];
    expect((await f.executor.inspect(f.run)).kind).toBe('needs-you');
    f.records.parent = [assistant('final', answer(review([{ sessionId: 'child', messageId: 'child-final' }])))];
    expect((await f.executor.inspect(f.run)).kind).toBe('done');
    f.records.child.unshift(assistant('new-final', 'A newer final output with corrections and different conclusions.'));
    expect((await f.executor.inspect(f.run)).kind).toBe('needs-you');
  });
  it.each(['failed', 'interrupted'])('refuses a %s child despite a success claim', async outcome => {
    const f = fixture(answer(review([{ sessionId: 'child', messageId: 'child-final' }])));
    f.run.children = [{ id: 'child', directory, title: 'Analysis' }];
    f.get.mockImplementation(async ({ sessionID }) => ({ id: sessionID, location: { directory }, outcome: sessionID === 'child' ? outcome : 'succeeded' }));
    expect((await f.executor.inspect(f.run)).kind).toBe('needs-you');
  });
  it.each([
    { id: 'source', type: 'user', time: { completed: 1 }, content: [{ type: 'text', text: 'Read attachment.pdf' }] },
    { id: 'source', type: 'assistant', content: [{ type: 'text', text: 'In progress' }] },
    { id: 'source', type: 'assistant', time: { completed: 1 }, content: [{ type: 'tool', state: { status: 'error' } }] },
  ])('refuses unavailable or unsuccessful source evidence', async source => {
    const f = fixture(answer(review([{ sessionId: 'parent', messageId: 'source' }])));
    f.records.parent.push(source);
    expect((await f.executor.inspect(f.run)).kind).toBe('needs-you');
  });
  it('accepts real completed tool evidence and refuses missing messages', async () => {
    const f = fixture(answer(review([{ sessionId: 'parent', messageId: 'source' }])));
    f.records.parent.push({ id: 'source', type: 'assistant', time: { completed: 1 }, content: [{ type: 'tool', state: { status: 'completed', content: [{ type: 'text', text: 'Actually opened reference content.' }] } }] });
    expect((await f.executor.inspect(f.run)).kind).toBe('done');
    f.records.parent.pop();
    expect((await f.executor.inspect(f.run)).kind).toBe('needs-you');
  });
  it('requires nonempty verified file provenance from the current run', async () => {
    const f = fixture(answer(review([], ['/project/team-output/result.md'])));
    expect((await f.executor.inspect(f.run)).kind).toBe('needs-you');
    const artifact = { path: '/project/team-output/result.md', sessionId: 'parent', verified: true, sha256: 'a'.repeat(64), sizeBytes: 42 };
    f.run.artifacts = [artifact];
    expect((await f.executor.inspect(f.run)).kind).toBe('done');
    f.run.artifacts = [{ ...artifact, sizeBytes: 0 }];
    expect((await f.executor.inspect(f.run)).kind).toBe('needs-you');
    f.run.artifacts = [{ ...artifact, sessionId: 'other' }];
    expect((await f.executor.inspect(f.run)).kind).toBe('needs-you');
  });
  it('does not turn a failed authoritative message read into empty success', async () => {
    const f = fixture(answer(review([{ sessionId: 'parent', messageId: 'source' }])));
    f.list.mockImplementation(async ({ limit }) => { if (limit === 100) throw new Error('Unavailable'); return { data: f.records.parent }; });
    await expect(f.executor.inspect(f.run)).rejects.toThrow('Unavailable');
  });
  it('resolves a source excerpt from a later authoritative page', async () => {
    const f = fixture(answer(review([{ sessionId: 'parent', messageId: 'source' }])));
    f.list.mockImplementation(async ({ limit, cursor }) => {
      if (limit === 20) return { data: f.records.parent };
      if (!cursor) return { data: f.records.parent, cursor: { next: 'older' } };
      return { data: [{ id: 'source', type: 'assistant', time: { completed: 1 }, content: [{ type: 'tool', state: { status: 'completed', content: [{ type: 'text', text: 'Actually opened reference content.' }] } }] }], cursor: { next: null } };
    });
    expect((await f.executor.inspect(f.run)).kind).toBe('done');
    expect(f.list.mock.calls.at(-1)[0]).toMatchObject({ cursor: 'older', limit: 100 });
  });
  it.each(['repeated', 'bounded'])('refuses unavailable evidence after a %s pagination scan', async mode => {
    const f = fixture(answer(review([{ sessionId: 'parent', messageId: 'source' }])));
    let pages = 0;
    f.list.mockImplementation(async ({ limit }) => {
      if (limit === 20) return { data: f.records.parent };
      pages += 1;
      return { data: [], cursor: { next: mode === 'repeated' ? 'same' : `page-${pages}` } };
    });
    expect((await f.executor.inspect(f.run)).kind).toBe('needs-you');
    expect(pages).toBe(mode === 'repeated' ? 2 : 8);
  });
  it('leaves authoritative running and pending work nonfinal', async () => {
    const f = fixture(answer(review()));
    f.records.parent[0].time = {};
    expect((await f.executor.inspect(f.run)).kind).toBe('pending');
    const executor = createAiTaskExecutor({ readProjects: async () => [], getClient: () => ({ session: { get: f.get, active: async () => ({ parent: { type: 'busy' } }) }, message: { list: f.list } }) });
    expect((await executor.inspect(f.run)).kind).toBe('running');
    expect(f.list).toHaveBeenCalledTimes(1);
  });
});

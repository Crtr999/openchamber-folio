import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { buildWebsiteChatScript, websiteChatSnapshotSchema, waitForWebsiteSnapshot } from './websiteChat';
const fixture = () => {
  const page = new Window({ url: 'https://gemini.google.com/app/conversation' });
  page.document.body.innerHTML = '<a aria-label="Google Account: Fixture" href="https://accounts.google.com/SignOutOptions"></a><user-query><div class="query-text">Hello</div></user-query><model-response><div class="model-response-text"><p>Reply</p><pre>const n = 4;</pre></div></model-response><rich-textarea><div contenteditable="true" role="textbox"></div></rich-textarea><button aria-label="Send message" disabled>Send</button>';
  return page;
};
test('Gemini reads actual bodies without modifying website DOM', async () => {
  const page = fixture(), before = page.document.body.innerHTML;
  const result = websiteChatSnapshotSchema.parse(await page.eval(buildWebsiteChatScript('gemini', { kind: 'snapshot' })));
  if (result.kind !== 'ready') throw Error('missing snapshot');
  expect(result.messages.map(row => row.role)).toEqual(['user', 'assistant']);
  expect(result.messages[1].text).toContain('```\nconst n = 4;\n```');
  expect(result.userCount).toBe(1); expect(page.document.body.innerHTML).toBe(before);
  page.happyDOM.abort();
});
test('Venice reads Copy/Edit message containers in order', async () => {
  const page = new Window({ url: 'https://venice.ai/chat/classic/observed' });
  page.document.body.innerHTML = '<button>Fixture fixture@example.test</button><article><p>Question</p><div><button aria-label="Edit">Edit</button><button aria-label="Copy">Copy</button></div></article><article><p>Answer</p><div><button aria-label="Copy">Copy</button></div></article><textarea placeholder="Ask anything privately..."></textarea>';
  const result = websiteChatSnapshotSchema.parse(await page.eval(buildWebsiteChatScript('venice', { kind: 'snapshot' })));
  if (result.kind !== 'ready') throw Error('missing snapshot');
  expect(result.messages).toEqual([{ role: 'user', text: 'Question', rich: false }, { role: 'assistant', text: 'Answer', rich: false }]);
  page.happyDOM.abort();
});
test('unrecognized history, sign-in, wrong origins and nonchat routes are unavailable', async () => {
  const page = fixture(); page.document.querySelectorAll('user-query, model-response').forEach(el => el.remove());
  expect(await page.eval(buildWebsiteChatScript('gemini', { kind: 'snapshot' }))).toMatchObject({ kind: 'website-required' });
  for (const url of ['https://accounts.google.com/', 'http://gemini.google.com/app', 'https://gemini.google.com.evil.test/app', 'https://gemini.google.com/settings']) {
    page.happyDOM.setURL(url); expect(await page.eval(buildWebsiteChatScript('gemini', { kind: 'snapshot' }))).toMatchObject({ kind: 'website-required' });
  }
  page.happyDOM.abort();
});
test('send uses the ordinary website input event and Send button once', async () => {
  const page = fixture(); let sends = 0;
  const input = page.document.querySelector('[contenteditable]'), button = page.document.querySelector('button');
  input?.addEventListener('input', () => button?.removeAttribute('disabled')); button?.addEventListener('click', () => sends++);
  expect(await page.eval(buildWebsiteChatScript('gemini', { kind: 'send', expectedDraft: '', text: 'My message', url: 'https://gemini.google.com/app/conversation' }))).toEqual({ kind: 'submitted' });
  expect(input?.textContent).toBe('My message'); expect(sends).toBe(1); page.happyDOM.abort();
});
test('changed pages, existing drafts and busy responses block duplicate sends', async () => {
  const page = fixture(), input = page.document.querySelector('[contenteditable]');
  if (!input) throw Error('missing input'); input.textContent = 'Existing draft';
  expect(await page.eval(buildWebsiteChatScript('gemini', { kind: 'send', expectedDraft: '', text: 'new', url: 'https://gemini.google.com/app/other' }))).toEqual({ kind: 'page-changed' });
  expect(await page.eval(buildWebsiteChatScript('gemini', { kind: 'send', expectedDraft: '', text: 'new', url: 'https://gemini.google.com/app/conversation' }))).toEqual({ kind: 'draft-conflict' });
  expect(input.textContent).toBe('Existing draft');
  page.document.body.insertAdjacentHTML('beforeend', '<button aria-label="Stop response">Stop</button>');
  expect(await page.eval(buildWebsiteChatScript('gemini', { kind: 'send', expectedDraft: '', text: 'new', url: 'https://gemini.google.com/app/conversation' }))).toEqual({ kind: 'busy' });
  let stops = 0; page.document.querySelector('[aria-label="Stop response"]')?.addEventListener('click', () => stops++);
  expect(await page.eval(buildWebsiteChatScript('gemini', { kind: 'stop', url: 'https://gemini.google.com/app/conversation' }))).toEqual({ kind: 'stopped' }); expect(stops).toBe(1); page.happyDOM.abort();
});
test('bounded history retains total user count for acknowledgement', async () => {
  const page = fixture(); page.document.body.insertAdjacentHTML('afterbegin', Array.from({ length: 150 }, (_, i) => `<user-query><p>Question ${i}</p></user-query><model-response><p>Reply ${i}</p></model-response>`).join(''));
  const result = websiteChatSnapshotSchema.parse(await page.eval(buildWebsiteChatScript('gemini', { kind: 'snapshot' })));
  if (result.kind !== 'ready') throw Error('missing snapshot');
  expect(result.partial).toBe(true); expect(result.messages.length).toBeLessThanOrEqual(120); expect(result.userCount).toBe(151); page.happyDOM.abort();
});

test('a submitted conversation survives loading documents without sending again', async () => {
  const page = fixture();
  const ready = websiteChatSnapshotSchema.parse(await page.eval(buildWebsiteChatScript('gemini', { kind: 'snapshot' })));
  let time = 0, reads = 0, checks = 0;
  const result = await waitForWebsiteSnapshot({
    read: async () => { reads++; if (reads === 1) throw new Error('Document replaced'); return reads < 4 ? { kind: 'website-required' } : ready; },
    ensureActive: async () => { checks++; }, wait: async () => { time += 500; }, now: () => time,
  });
  expect(result).toEqual(ready); expect(reads).toBe(4); expect(checks).toBe(4);
  page.happyDOM.abort();
});
test('unavailable website expires and cancellation is never swallowed', async () => {
  let time = 0;
  await expect(waitForWebsiteSnapshot({ read: async () => ({ kind: 'website-required' }), ensureActive: async () => {}, wait: async () => { time += 500; }, now: () => time })).rejects.toThrow('pending reply');
  expect(time).toBe(30_000);
  await expect(waitForWebsiteSnapshot({ read: async () => ({ kind: 'website-required' }), ensureActive: async () => { throw new Error('Cancelled'); }, wait: async () => {} })).rejects.toThrow('Cancelled');
});

test('Gemini waits for its framework to enable Send and clicks only once', async () => {
  const page = fixture(); let sends = 0;
  const button = page.document.querySelector('button');
  page.document.querySelector('[contenteditable]')?.addEventListener('input', () => setTimeout(() => button?.removeAttribute('disabled'), 350));
  button?.addEventListener('click', () => sends++);
  expect(await page.eval(buildWebsiteChatScript('gemini', { kind: 'send', expectedDraft: '', text: 'Delayed send', url: 'https://gemini.google.com/app/conversation' }))).toEqual({ kind: 'submitted' });
  expect(sends).toBe(1); page.happyDOM.abort();
});

test('Gemini chooses its visible prompt editor instead of an obsolete hidden editor', async () => {
  const page = fixture();
  page.document.querySelector('rich-textarea')?.setAttribute('hidden', '');
  page.document.body.insertAdjacentHTML('beforeend', '<div contenteditable="true" aria-label="Enter a prompt for Gemini"></div>');
  const editor = page.document.querySelector('[aria-label="Enter a prompt for Gemini"]');
  const button = page.document.querySelector('button');
  editor?.addEventListener('input', () => button?.removeAttribute('disabled'));
  expect(await page.eval(buildWebsiteChatScript('gemini', { kind: 'send', expectedDraft: '', text: 'Visible editor', url: 'https://gemini.google.com/app/conversation' }))).toEqual({ kind: 'submitted' });
  expect(editor?.textContent).toBe('Visible editor');
  expect(page.document.querySelector('rich-textarea [contenteditable]')?.textContent).toBe('');
  page.happyDOM.abort();
});

test('rich-editor line-break normalization does not look like a replaced draft', async () => {
  const page = fixture(), editor = page.document.querySelector('[contenteditable]'), button = page.document.querySelector('button');
  editor?.addEventListener('input', () => { if (editor) editor.textContent = (editor.textContent || '').replace(/\n/g, '\n\n'); button?.removeAttribute('disabled'); });
  expect(await page.eval(buildWebsiteChatScript('gemini', { kind: 'send', expectedDraft: '', text: 'First line\nSecond line', url: 'https://gemini.google.com/app/conversation' }))).toEqual({ kind: 'submitted' });
  page.happyDOM.abort();
});

test('a fresh rich editor may contain a blank line: send compares the captured draft', async () => {
  const page = fixture();
  const editor = page.document.querySelector('[contenteditable]'), button = page.document.querySelector('button');
  if (!editor) throw new Error('Missing editor');
  editor.textContent = '\n';
  const snapshot = websiteChatSnapshotSchema.parse(await page.eval(buildWebsiteChatScript('gemini', { kind: 'snapshot' })));
  if (snapshot.kind !== 'ready') throw new Error('Missing snapshot');
  expect(snapshot.draft.trim()).toBe('');
  editor.addEventListener('input', () => button?.removeAttribute('disabled'));
  expect(await page.eval(buildWebsiteChatScript('gemini', { kind: 'send', expectedDraft: snapshot.draft, text: 'A normal message', url: snapshot.url }))).toEqual({ kind: 'submitted' });
  page.happyDOM.abort();
});

test('Venice reads data-message-id messages and tells user from assistant by the user toolbar', async () => {
  const page = new Window({ url: 'https://venice.ai/chat/classic' });
  page.document.body.innerHTML = '<button>Fixture fixture@example.test</button><div class="chat-messages-content"><div data-message-id="a1"><div data-message-content="true"><p>Question</p></div><div class="chat-user-msg-actions"><button aria-label="Copy">Copy</button><button aria-label="Edit Response">Edit Response</button></div></div><div data-message-id="b2"><div><p>Answer</p></div><button aria-label="Regenerate">Regenerate</button><button aria-label="Copy">Copy</button></div></div><textarea placeholder="Ask anything privately..."></textarea>';
  const result = websiteChatSnapshotSchema.parse(await page.eval(buildWebsiteChatScript('venice', { kind: 'snapshot' })));
  if (result.kind !== 'ready') throw Error('missing snapshot');
  expect(result.messages.map(row => [row.role, row.text])).toEqual([['user', 'Question'], ['assistant', 'Answer']]);
  expect(result.userCount).toBe(1);
  page.happyDOM.abort();
});

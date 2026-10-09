import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { buildWebsiteScript, isChatGPTOrigin, isChatGPTPagePath, websiteSnapshotSchema } from './website';

function page() {
  const window = new Window({ url: 'https://chatgpt.com/c/first' });
  window.document.body.innerHTML = `<aside id="stage-sidebar"><nav><button>Library</button><a href="/c/first">First</a><a href="https://evil.example/c/wrong">Wrong</a><a href="/g/g-p-project/c/project-chat">Project chat</a><a href="/g/project/project">Project</a></nav></aside><div><button aria-label="Open profile menu"></button><span>Account A Plus</span></div><main><div contenteditable="true">Draft stays here</div></main>`;
  return window;
}

test('mirror reads only same-origin navigation and leaves composer content intact', () => {
  const window = page();
  const result = websiteSnapshotSchema.parse(window.eval(buildWebsiteScript({ kind: 'snapshot', integrated: true })));
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') throw new Error('Missing ready snapshot');
  expect(result.chats).toEqual([{ path: '/c/first', title: 'First' }, { path: '/g/g-p-project/c/project-chat', title: 'Project chat' }]);
  expect(result.projects).toEqual([{ path: '/g/project/project', title: 'Project' }]);
  expect(window.document.querySelector('[contenteditable]')?.textContent).toBe('Draft stays here');
  expect(window.document.querySelector('aside')?.hasAttribute('inert')).toBe(true);
  window.close();
});

test('full view restores navigation even when account controls disappear', () => {
  const window = page();
  window.eval(buildWebsiteScript({ kind: 'snapshot', integrated: true }));
  window.document.querySelector('[aria-label="Open profile menu"]')?.remove();
  window.eval(buildWebsiteScript({ kind: 'snapshot', integrated: false }));
  expect(window.document.getElementById('open-carter-chatgpt-layout')).toBeNull();
  expect(window.document.querySelector('aside')?.hasAttribute('inert')).toBe(false);
  window.close();
});

test('website controls run only as explicit shortcuts on the fixed origin', () => {
  const window = page();
  let clicks = 0;
  window.document.querySelector('nav button')?.addEventListener('click', () => { clicks += 1; });
  expect(window.eval(buildWebsiteScript({ kind: 'shortcut', label: 'Library' }))).toBe(true);
  expect(clicks).toBe(1);
  window.location.href = 'https://evil.example/';
  expect(window.eval(buildWebsiteScript({ kind: 'shortcut', label: 'Library' }))).toEqual({ kind: 'unavailable' });
  expect(clicks).toBe(1);
  window.close();
});

test('navigation rejects third-party URLs and query credentials', () => {
  expect(isChatGPTOrigin('https://chatgpt.com/c/123')).toBe(true);
  expect(isChatGPTOrigin('https://chatgpt.com.evil.example/')).toBe(false);
  expect(isChatGPTPagePath('/c/123')).toBe(true);
  expect(isChatGPTPagePath('/c/123?token=secret')).toBe(false);
  expect(isChatGPTPagePath('//evil.example/')).toBe(false);
  expect(websiteSnapshotSchema.safeParse({ kind: 'ready', account: 'A', path: '/', chats: [{ path: 'https://evil.example/', title: 'Wrong' }], projects: [], integratedAvailable: true }).success).toBe(false);
});


test('integrated view hides the complete sidebar column, not only history', () => {
  const window = page();
  window.document.body.innerHTML = `<div id="width-shell"><div id="column"><div>ChatGPT</div><nav><button>New chat</button><a href="/c/first">First</a></nav><footer><button aria-label="Open profile menu"></button>Account A</footer></div></div><main><div id="prompt-textarea" contenteditable="true">Unsent draft</div></main>`;
  window.eval(buildWebsiteScript({ kind: 'snapshot', integrated: true }));
  expect(window.document.getElementById('width-shell')?.hasAttribute('data-open-carter-sidebar')).toBe(true);
  expect(window.document.querySelector('main')?.hasAttribute('inert')).toBe(false);
  let clicks = 0;
  window.document.querySelector('nav button')?.addEventListener('click', () => { clicks += 1; });
  expect(window.eval(buildWebsiteScript({ kind: 'navigate', path: '/' }))).toBe(true);
  expect(clicks).toBe(1);
  expect(window.document.getElementById('prompt-textarea')?.textContent).toBe('Unsent draft');
  window.close();
});


test('native navigation never clicks a third-party link with the same path', () => {
  const window = page();
  window.document.querySelector('a[href="/c/first"]')?.remove();
  const evil = window.document.querySelector('a[href^="https://evil"]');
  evil?.setAttribute('href', 'https://evil.example/c/first');
  let clicks = 0; evil?.addEventListener('click', () => { clicks += 1; });
  expect(window.eval(buildWebsiteScript({ kind: 'navigate', path: '/c/first' }))).toBe(false);
  expect(clicks).toBe(0);
  window.close();
});

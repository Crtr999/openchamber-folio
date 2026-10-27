import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hardenWebsiteSessions, secureWebsiteAttachment, setTeachingOrigin } from './website-guest-security.mjs';

const websites = [
  ['persist:open-carter-claude', 'https://claude.ai/'],
  ['persist:open-carter-venice', 'https://venice.ai/chat'],
  ['persist:open-carter-gemini', 'https://gemini.google.com/app'],
];

test('website partitions deny requests, checks and device access', () => {
  const partitions = [];
  hardenWebsiteSessions(partition => {
    partitions.push(partition);
    return {
      setPermissionRequestHandler(handler) {
        for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read']) {
          handler(null, permission, allowed => assert.equal(allowed, false));
        }
      },
      setPermissionCheckHandler(handler) { assert.equal(handler(), false); },
      webRequest: { onBeforeRequest() {} },
      setDevicePermissionHandler(handler) { assert.equal(handler(), false); },
    };
  });
  assert.deepEqual(partitions, [...websites.map(([partition]) => partition), 'open-carter-teaching']);
});

test('teaching is denied until configured, then isolated and local-parent only', () => {
  const partition = 'open-carter-teaching';
  const attach = (src, localParent) => {
    let refused = false;
    const preferences = { preload: '/secret.mjs', nodeIntegration: true };
    secureWebsiteAttachment({ event: { preventDefault() { refused = true; } }, webPreferences: preferences, params: { partition, src }, localParent });
    return { refused, preferences };
  };
  assert.equal(attach('http://localhost:7800/', true).refused, true);
  setTeachingOrigin('http://localhost:7800');
  assert.equal(attach('http://localhost:7800/', false).refused, true);
  assert.equal(attach('http://localhost:7801/', true).refused, true);
  const allowed = attach('http://localhost:7800/?screen=open-carter-teach&solo=1', true);
  assert.equal(allowed.refused, false);
  assert.equal(allowed.preferences.nodeIntegration, false);
  assert.equal(allowed.preferences.preload, undefined);
  assert.throws(() => setTeachingOrigin('http://evil.example'));
});

for (const [partition, src] of websites) {
  test(`${partition} strips preload and forces isolated guest preferences`, () => {
    const preferences = { preload: '/privileged.mjs', preloadURL: 'file:///privileged.mjs', session: {}, partition, nodeIntegration: true, sandbox: false, webSecurity: false };
    secureWebsiteAttachment({ event: { preventDefault() { assert.fail('local attachment should succeed'); } }, webPreferences: preferences, params: { partition, src }, localParent: true });
    assert.equal(preferences.preload, undefined);
    assert.equal(preferences.preloadURL, undefined);
    assert.equal(preferences.session, undefined);
    assert.equal(preferences.partition, partition);
    for (const key of ['nodeIntegration', 'nodeIntegrationInWorker', 'nodeIntegrationInSubFrames', 'allowRunningInsecureContent', 'webviewTag']) assert.equal(preferences[key], false);
    for (const key of ['sandbox', 'contextIsolation', 'webSecurity']) assert.equal(preferences[key], true);
  });

  test(`${partition} refuses remote parents and invalid initial origins`, () => {
    for (const [localParent, source] of [[false, src], [true, src.replace('https:', 'http:')], [true, src.replace(new URL(src).hostname, new URL(src).hostname + '.evil.test')], [true, 'about:blank'], [true, src.replace('https://', 'https://user:secret@')]]) {
      let refused = false;
      secureWebsiteAttachment({ event: { preventDefault() { refused = true; } }, webPreferences: {}, params: { partition, src: source }, localParent });
      assert.equal(refused, true);
    }
  });
}

test('a conflicting partition cannot borrow another website session', () => {
  let refused = false;
  secureWebsiteAttachment({ event: { preventDefault() { refused = true; } }, webPreferences: { partition: websites[0][0] }, params: { partition: 'persist:open-carter-other', src: websites[0][1] }, localParent: true });
  assert.equal(refused, true);
});

test('ChatGPT/browser controller partition remains outside this policy', () => {
  const preferences = { partition: 'persist:openchamber-browser' };
  secureWebsiteAttachment({ event: { preventDefault() { assert.fail('browser policy changed'); } }, webPreferences: preferences, params: { partition: preferences.partition, src: 'https://chatgpt.com/' }, localParent: false });
  assert.deepEqual(preferences, { partition: 'persist:openchamber-browser' });
  const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.match(main, /target\.session !== session\.fromPartition\(BROWSER_PANEL_PARTITION\)/);
  assert.match(main, /contents\.on\('will-attach-webview'/);
  assert.match(main, /parent && isLocalSender\(contents\)/);
  assert.match(main, /sameOrigin\(runtime\?\.apiBaseUrl/);
});


for (const [partition, src] of websites.filter(([partition]) => partition !== 'persist:open-carter-claude')) {
  test(`${partition} refuses attachment and network access under enterprise policy`, () => {
    let refused = false;
    secureWebsiteAttachment({ event: { preventDefault() { refused = true; } }, webPreferences: {}, params: { partition, src }, localParent: true, enterpriseBlocked: true });
    assert.equal(refused, true);
    const requests = new Map();
    let blocked = false;
    hardenWebsiteSessions(name => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {}, webRequest: { onBeforeRequest(handler) { requests.set(name, handler); } } }), () => blocked);
    requests.get(partition)({}, result => assert.equal(result.cancel, false));
    blocked = true;
    requests.get(partition)({}, result => assert.equal(result.cancel, true));
  });
}


test('only Venice can retain its own storage; other origins and permissions remain denied', () => {
  let blocked = false;
  const handlers = new Map();
  hardenWebsiteSessions(partition => {
    const row = {}; handlers.set(partition, row);
    return { setPermissionRequestHandler(handler) { row.request = handler; }, setPermissionCheckHandler(handler) { row.check = handler; }, setDevicePermissionHandler() {}, webRequest: { onBeforeRequest() {} } };
  }, () => blocked);
  const venice = handlers.get('persist:open-carter-venice');
  const request = (permission, requestingUrl) => { let result; venice.request(null, permission, value => { result = value; }, { requestingUrl }); return result; };
  assert.equal(request('persistent-storage', 'https://venice.ai/chat/classic'), true);
  assert.equal(venice.check(null, 'persistent-storage', 'https://venice.ai'), true);
  for (const origin of ['https://venice.ai.evil.test/', 'https://evil.test/', 'http://venice.ai/', 'invalid']) assert.equal(request('persistent-storage', origin), false);
  for (const permission of ['media', 'display-capture', 'notifications', 'clipboard-read', 'geolocation']) assert.equal(request(permission, 'https://venice.ai'), false);
  assert.equal(handlers.get('persist:open-carter-claude').check(null, 'persistent-storage', 'https://venice.ai'), false);
  blocked = true;
  assert.equal(request('persistent-storage', 'https://venice.ai'), false);
});

test('Gemini keeps its real browser versions without shell product tokens', () => {
  const changed = new Map();
  const original = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) OpenCarter/2.0.4 Chrome/138.0.7204.243 Electron/37.4.0 Safari/537.36';
  hardenWebsiteSessions(partition => ({
    getUserAgent: () => original,
    setUserAgent: value => changed.set(partition, value),
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {}, webRequest: { onBeforeRequest() {} },
  }));
  assert.deepEqual([...changed.keys()], ['persist:open-carter-gemini']);
  const browser = changed.get('persist:open-carter-gemini');
  assert.match(browser, /Chrome\/138\.0\.7204\.243/);
  assert.match(browser, /Mac OS X 10_15_7/);
  assert.doesNotMatch(browser, /Electron|OpenCarter/);
});

test('Gemini drops the OpenChamberPersonal shell token the app actually sends', () => {
  const changed = new Map();
  const original = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) OpenChamberPersonal/2.0.4 Chrome/150.0.7871.250 Safari/537.36';
  hardenWebsiteSessions(partition => ({
    getUserAgent: () => original,
    setUserAgent: value => changed.set(partition, value),
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {}, webRequest: { onBeforeRequest() {} },
  }));
  assert.equal(changed.get('persist:open-carter-gemini'), 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.250 Safari/537.36');
});

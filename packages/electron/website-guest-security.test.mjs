import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hardenWebsiteSessions, secureWebsiteAttachment } from './website-guest-security.mjs';

const websites = [
  ['persist:open-carter-muse', 'https://muse.ai/'],
  ['persist:open-carter-claude', 'https://claude.ai/'],
];

test('both website partitions deny requests, checks and device access', () => {
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
      setDevicePermissionHandler(handler) { assert.equal(handler(), false); },
    };
  });
  assert.deepEqual(partitions, websites.map(([partition]) => partition));
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
    for (const [localParent, source] of [[false, src], [true, src.replace('https:', 'http:')], [true, src.replace('.ai/', '.ai.evil.test/')], [true, 'about:blank'], [true, src.replace('https://', 'https://user:secret@')]]) {
      let refused = false;
      secureWebsiteAttachment({ event: { preventDefault() { refused = true; } }, webPreferences: {}, params: { partition, src: source }, localParent });
      assert.equal(refused, true);
    }
  });
}

test('a conflicting partition cannot borrow another website session', () => {
  let refused = false;
  secureWebsiteAttachment({ event: { preventDefault() { refused = true; } }, webPreferences: { partition: websites[0][0] }, params: { partition: websites[1][0], src: websites[1][1] }, localParent: true });
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

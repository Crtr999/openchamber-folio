import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createSummonShortcut, DEFAULT_SUMMON_ACCELERATOR } from './summon-shortcut.mjs';

const fixture = ({ focused = false, visible = true, minimized = false, destroyed = false } = {}) => {
  const calls = [];
  const registrations = new Map();
  const unavailable = [];
  const errors = [];
  const window = {
    isFocused: () => focused,
    isVisible: () => visible,
    isMinimized: () => minimized,
    isDestroyed: () => destroyed,
    hide: () => { calls.push('hide'); },
  };
  let target = window;
  let allowed = true;
  let reveal = async () => { calls.push('reveal'); };
  const globalShortcut = {
    isRegistered: (accelerator) => registrations.has(accelerator),
    register: (accelerator, callback) => {
      calls.push('register');
      registrations.set(accelerator, callback);
      return true;
    },
    unregister: (accelerator) => {
      calls.push('unregister');
      registrations.delete(accelerator);
    },
  };
  const shortcut = createSummonShortcut({
    globalShortcut,
    getWindow: () => target,
    revealWindow: (shouldReveal) => reveal(shouldReveal),
    beforeHide: (candidate) => { assert.equal(candidate, window); calls.push('persist'); },
    canToggle: () => allowed,
    onUnavailable: (accelerator) => unavailable.push(accelerator),
    onError: (error) => errors.push(error),
  });
  return {
    shortcut, calls, registrations, unavailable, errors, globalShortcut,
    press: () => registrations.get(DEFAULT_SUMMON_ACCELERATOR)(),
    setAllowed: (value) => { allowed = value; },
    setTarget: (value) => { target = value; },
    setReveal: (value) => { reveal = value; },
  };
};

test('registers the approved default once without changing other shortcuts', () => {
  const f = fixture();
  const other = () => {};
  f.registrations.set('Other', other);
  assert.equal(DEFAULT_SUMMON_ACCELERATOR, 'CommandOrControl+Shift+Space');
  assert.equal(f.shortcut.start(), true);
  assert.equal(f.shortcut.start(), true);
  assert.deepEqual(f.calls, ['register']);
  f.shortcut.stop();
  f.shortcut.stop();
  assert.deepEqual(f.calls, ['register', 'unregister']);
  assert.equal(f.registrations.get('Other'), other);
});

test('persists geometry and hides only the focused visible main window', async () => {
  const f = fixture({ focused: true });
  f.shortcut.start();
  await f.press();
  assert.deepEqual(f.calls, ['register', 'persist', 'hide']);
});

for (const [name, options] of [
  ['unfocused visible', {}],
  ['hidden', { visible: false, focused: true }],
  ['minimized', { minimized: true, focused: true }],
  ['destroyed', { destroyed: true, focused: true }],
]) {
  test(`reveals the ${name} main window instead of hiding or navigating`, async () => {
    const f = fixture(options);
    f.shortcut.start();
    await f.press();
    assert.deepEqual(f.calls, ['register', 'reveal']);
  });
}

test('coalesces presses while recreating a closed window', async () => {
  const f = fixture();
  f.setTarget(null);
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  f.setReveal(() => { f.calls.push('recreate'); return pending; });
  f.shortcut.start();
  const first = f.press();
  await f.press();
  await f.press();
  assert.deepEqual(f.calls, ['register', 'recreate']);
  finish();
  await first;
  await f.press();
  assert.deepEqual(f.calls, ['register', 'recreate', 'recreate']);
});

test('reports OS registration refusal without falling back or unregistering', () => {
  const f = fixture();
  f.globalShortcut.register = () => false;
  assert.equal(f.shortcut.start(), false);
  assert.deepEqual(f.unavailable, [DEFAULT_SUMMON_ACCELERATOR]);
  f.shortcut.stop();
  assert.deepEqual(f.calls, []);
});

test('does not replace or unregister an accelerator already owned in this process', () => {
  const f = fixture();
  const other = () => {};
  f.registrations.set(DEFAULT_SUMMON_ACCELERATOR, other);
  assert.equal(f.shortcut.start(), false);
  f.shortcut.stop();
  assert.equal(f.registrations.get(DEFAULT_SUMMON_ACCELERATOR), other);
  assert.deepEqual(f.unavailable, [DEFAULT_SUMMON_ACCELERATOR]);
  assert.deepEqual(f.calls, []);
});

test('handles registration exceptions and can retry without saved settings changes', () => {
  const f = fixture();
  const register = f.globalShortcut.register;
  f.globalShortcut.register = () => { throw new Error('unavailable'); };
  assert.equal(f.shortcut.start(), false);
  f.globalShortcut.register = register;
  assert.equal(f.shortcut.start(), true);
  assert.deepEqual(f.unavailable, [DEFAULT_SUMMON_ACCELERATOR]);
  f.shortcut.stop();
});

test('suppresses actions during confirmed shutdown and permits them again if allowed', async () => {
  const f = fixture();
  f.shortcut.start();
  f.setAllowed(false);
  await f.press();
  assert.deepEqual(f.calls, ['register']);
  f.setAllowed(true);
  await f.press();
  assert.deepEqual(f.calls, ['register', 'reveal']);
});

test('retained callbacks are inert after stop, including during an in-flight reveal', async () => {
  const f = fixture();
  let finish;
  f.setReveal(() => new Promise((resolve) => { finish = resolve; }));
  f.shortcut.start();
  const callback = f.registrations.get(DEFAULT_SUMMON_ACCELERATOR);
  const pending = callback();
  f.shortcut.stop();
  await callback();
  finish();
  await pending;
  await callback();
  assert.deepEqual(f.calls, ['register', 'unregister']);
});

test('reports reveal failure and releases the pending toggle for the next press', async () => {
  const f = fixture();
  const error = new Error('window failed');
  f.setReveal(async () => { throw error; });
  f.shortcut.start();
  await f.press();
  assert.deepEqual(f.errors, [error]);
  f.setReveal(async () => { f.calls.push('reveal'); });
  await f.press();
  assert.deepEqual(f.calls, ['register', 'reveal']);
});

for (const reason of ['stop', 'quit']) {
  test(`${reason} cancels the pending reveal before it can show a window`, async () => {
    const f = fixture();
    f.setTarget(null);
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    f.setReveal(async (shouldReveal) => {
      await pending;
      if (shouldReveal()) f.calls.push('show');
    });
    f.shortcut.start();
    const revealing = f.press();
    if (reason === 'stop') f.shortcut.stop();
    else f.setAllowed(false);
    finish();
    await revealing;
    assert.equal(f.calls.includes('show'), false);
  });
}

test('a delayed ready-to-show guard stays canceled after stop and re-registration', async () => {
  const f = fixture();
  let readyToShow;
  f.setReveal(async (shouldReveal) => { readyToShow = shouldReveal; });
  f.shortcut.start();
  await f.press();
  assert.equal(readyToShow(), true);
  f.shortcut.stop();
  assert.equal(readyToShow(), false);
  f.shortcut.start();
  assert.equal(readyToShow(), false);
  await f.press();
  assert.equal(readyToShow(), true);
});

test('main wires registration after visible and background startup and exit-only cleanup', () => {
  const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.equal(main.match(/summonShortcut\.start\(\)/g)?.length, 2);
  assert.match(main, /started in background without window'\);\s+summonShortcut\.start\(\)/);
  assert.match(main, /await activateMainWindow\(initialUrl[^\n]+\n\s+summonShortcut\.start\(\)/);
  assert.match(main, /app\.once\('will-quit', \(\) => summonShortcut\.stop\(\)\)/);
  assert.match(main, /revealWindow: revealMainWindow/);
  const reveal = main.slice(main.indexOf('const revealMainWindow ='), main.indexOf('const summonShortcut ='));
  assert.match(reveal, /if \(!target \|\| target\.isDestroyed\(\)\) \{\s+target = await openMainWindow\(\{ shouldShow \}\)/);
  assert.match(reveal, /if \(shouldShow\(\) && target && !target\.isDestroyed\(\)\)/);
  assert.match(reveal, /if \(target\.isMinimized\(\)\) target\.restore\(\)/);
  assert.doesNotMatch(reveal, /navigateWindow|\.loadURL|\.reload/);
  assert.match(main, /browserWindow\.once\('ready-to-show', \(\) => \{\s+if \(browserWindow\.isDestroyed\(\) \|\| !shouldShow\(\)\) return/);
  assert.match(main, /const activateMainWindow = [^\n]+\{\s+if \(!shouldShow\(\)\) return null/);
  assert.match(main, /await navigateWindow\(mainWindow, url, \{ allowAbort: true \}\);\s+if \(mainWindow\.isDestroyed\(\) \|\| !shouldShow\(\)\) return null/);
});

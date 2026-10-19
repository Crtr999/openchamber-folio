import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isOpenRouterCreditsAuthorized } from './openrouter-credits.mjs';

const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');

test('isolated packaged QA profiles never change the installed app login registration', () => {
  const login = main.slice(main.indexOf("const marker = path.join(app.getPath('userData'), 'open-carter-login-default')") - 600);
  assert.match(login, /app\.isPackaged && !process\.env\.OPENCHAMBER_DESKTOP_USER_DATA_DIR/);
});

test('system resume requests durable team reconciliation except during confirmed shutdown', () => {
  const resume = main.slice(main.indexOf("powerMonitor.on('resume'"), main.indexOf('setupAutoUpdater();', main.indexOf("powerMonitor.on('resume'")));
  assert.match(resume, /!state\.quitConfirmed && !state\.backgroundShutdownPromise/);
  assert.match(resume, /state\.serverHandle\?\.getTeam\(\)\?\.check\(\)/);
  assert.match(resume, /log\.warn\('Team reconciliation after wake did not complete/);
});

test('host and team IPC reuse the trusted local main-frame gate before and after awaiting', () => {
  const invoke = main.slice(main.indexOf("ipcMain.handle('openchamber:invoke'"), main.indexOf("ipcMain.handle('openchamber:dialog:open'"));
  assert.match(invoke, /const localHostCommand = \['desktop_ai_host_status', 'desktop_ai_host_configure', 'desktop_personal_teaching', 'desktop_teaching_skill'\]/);
  assert.match(invoke, /const localTeamCommand = command === 'desktop_personal_home'.*startsWith\('team-'\)/);
  const gate = '(localHostCommand || localTeamCommand) && !authorizeOpenRouterCredits(event)';
  assert.equal((invoke.match(/\(localHostCommand \|\| localTeamCommand\) && !authorizeOpenRouterCredits\(event\)/g) || []).length, 2);
  assert.ok(invoke.indexOf(gate) < invoke.indexOf('await handleInvoke'));
  assert.ok(invoke.lastIndexOf(gate) > invoke.indexOf('await handleInvoke'));
  const safe = main.slice(main.indexOf('const COMMANDS_SAFE_FOR_REMOTE'), main.indexOf("ipcMain.handle('openchamber:invoke'"));
  assert.doesNotMatch(safe, /desktop_ai_host/);
  assert.doesNotMatch(safe, /desktop_personal_home/);
  assert.doesNotMatch(safe, /desktop_personal_teaching/);
  assert.doesNotMatch(safe, /desktop_teaching_skill/);
  const skills = invoke.slice(invoke.indexOf("if (command === 'desktop_teaching_skill')"), invoke.indexOf('if (isMeetingCommand'));
  assert.match(skills, /teachingSkillInput\.parse\(args\)/);
  assert.match(skills, /authorizeOpenRouterCredits\(event\)/);
  assert.match(skills, /input, authorize/);
  assert.match(skills, /authorize\(\); return result/);
});

test('team startup uses separate durable state and an authoritative native wake observer', () => {
  assert.match(main, /filePath: path\.join\(app\.getPath\('userData'\), 'team-work\.json'\)/);
  assert.match(main, /guardrails: \{ projectTokens: 5_000_000, accountTokens: 10_000_000 \}/);
  assert.match(main, /onWorkState: \(value\) => \{ macAiHost\.setTeamWork\(value\); \}/);
  assert.match(main, /getTeam: \(\) => state\.serverHandle\?\.getTeam\(\) \?\? null/);
  assert.match(main, /if \(args\.action\?\.startsWith\('team-'\)\) return localTeamBridge\.handle\(args\)/);
});

test('the reused gate rejects remote runtimes, child frames, guests and other windows', () => {
  const mainFrame = { url: 'openchamber-ui://app/home' };
  const contents = { mainFrame, isDestroyed: () => false };
  const owner = { webContents: contents, isDestroyed: () => false };
  const context = { owner, localOrigin: 'openchamber-ui://app', localRuntime: true };
  const event = { sender: contents, senderFrame: mainFrame };
  assert.equal(isOpenRouterCreditsAuthorized(event, context), true);
  assert.equal(isOpenRouterCreditsAuthorized(event, { ...context, localRuntime: false }), false);
  assert.equal(isOpenRouterCreditsAuthorized({ ...event, senderFrame: { ...mainFrame } }, context), false);
  assert.equal(isOpenRouterCreditsAuthorized({ sender: { ...contents }, senderFrame: mainFrame }, context), false);
  for (const url of ['https://example.com', 'http://127.0.0.1:9999', 'file:///app/index.html', 'about:blank']) {
    mainFrame.url = url;
    assert.equal(isOpenRouterCreditsAuthorized(event, context), false, url);
  }
});

test('confirmed shutdown releases native protection before backend drain and then closes adapter', () => {
  const shutdown = main.slice(main.indexOf('const shutdownBackgroundServices'), main.indexOf('const shutdownSshSessions'));
  assert.ok(shutdown.indexOf('macAiHost.stop()') < shutdown.indexOf('killSidecar()'));
  assert.match(shutdown, /killSidecar\(\)\.finally\(\(\) => personalHome\.close\(\)\)/);
  const beforeQuit = main.slice(main.indexOf("app.on('before-quit'"), main.indexOf('const handleSecondInstance'));
  assert.doesNotMatch(beforeQuit, /aiTasks.*close|personalHome\.close|macAiHost\.stop/);
  assert.match(beforeQuit, /requestQuitWithConfirmation/);
  assert.match(main, /aiTasks = handle\.getAiTasks\(\)/);
  assert.doesNotMatch(main, /aiTasks\??\.start\(/);
});

test('saved login opt-out, Mac close semantics and adapter injection remain present', () => {
  assert.match(main, /open-carter-login-default/);
  assert.match(main, /if \(!fs\.existsSync\(marker\)\)/);
  assert.match(main, /let openAtLogin = loginItemSettings\?\.openAtLogin === true/);
  assert.match(main, /process\.platform === 'darwin' && !state\.quitRequested/);
  assert.match(main, /notion: personalHome\.automation/);
  assert.match(main, /if \(state\.backgroundShutdownPromise \|\| state\.quitConfirmed\)/);
});

test('repeated startup shares one server promise and quit awaits its unpublished handle', () => {
  const startup = main.slice(main.indexOf('const spawnLocalServer'), main.indexOf('const startLocalServer'));
  assert.match(startup, /if \(state\.serverStartupPromise\) return state\.serverStartupPromise/);
  assert.match(startup, /if \(state\.serverHandle\) return Promise\.resolve\(state\.sidecarUrl\)/);
  assert.match(startup, /state\.serverStartupPromise = startLocalServer\(\)\.finally/);
  const kill = main.slice(main.indexOf('const killSidecar'), main.indexOf('const buildInitScript'));
  assert.ok(kill.indexOf('await state.serverStartupPromise') < kill.indexOf('const handle = state.serverHandle'));
  const server = main.slice(main.indexOf('const startLocalServer'), main.indexOf('const launchDetachedOpenCodeKiller'));
  assert.ok(server.indexOf('await stopEmbeddedServer(handle') < server.indexOf('state.serverHandle = handle'));
});

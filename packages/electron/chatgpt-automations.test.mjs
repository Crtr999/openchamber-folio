import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatGPTAutomationsBridge, describeAutomationSchedule, parseAutomationToml } from './chatgpt-automations.mjs';

// The rules carry no timezone, so the next run is the next local occurrence.
// Pinning the zone keeps these expectations identical on any host.
process.env.TZ = 'America/New_York';

const FROM = Date.parse('2026-10-18T12:00:00Z');
// The schedule rules carry no timezone, so expectations are written as local
// wall-clock times and hold on any host.
const localTime = (day, hour, minute) => new Date(2026, 9, day, hour, minute, 0, 0).getTime();
const automation = (overrides = {}) => [
  'version = 1',
  `id = "${overrides.id ?? 'kelby-research-evidence-and-daily-tests'}"`,
  'kind = "heartbeat"',
  `name = "${overrides.name ?? 'Kelby research evidence and daily tests'}"`,
  `status = "${overrides.status ?? 'ACTIVE'}"`,
  `rrule = "${overrides.rrule ?? 'FREQ=DAILY;BYHOUR=18;BYMINUTE=15;BYSECOND=0'}"`,
  'target_thread_id = "01a145f6-aef5-7982-83f0-a944d36b50c8"',
  'created_at = 1792175750128',
  'updated_at = 1792175750128',
  'prompt = "Maintain the research system."',
].join('\n');
const replacePrompt = (source, prompt) => source.replace('prompt = "Maintain the research system."', `prompt = ${prompt}`);

/** A directory listing plus file reader over an in-memory ~/.codex/automations tree. */
function fakeHome(files, { failure = null } = {}) {
  return {
    homeDirectory: () => '/Users/carter',
    resolveTimeZone: () => 'America/New_York',
    now: () => FROM,
    readDirectory: (directory) => {
      if (failure) throw failure;
      assert.equal(directory, '/Users/carter/.codex/automations');
      return Object.keys(files).map((name) => ({ name, isDirectory: () => true }));
    },
    readFile: (file) => {
      const id = file.split('/').at(-2);
      if (!(id in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[id];
    },
  };
}

test('a real automation file is read into a provider row with its own identities', async () => {
  const bridge = createChatGPTAutomationsBridge(fakeHome({ 'kelby-research-evidence-and-daily-tests': automation() }));
  assert.deepEqual(await bridge.handle({ action: 'chatgpt-automations-list' }), {
    rows: [{
      providerJobId: 'kelby-research-evidence-and-daily-tests',
      name: 'Kelby research evidence and daily tests',
      kind: 'heartbeat',
      status: 'ACTIVE',
      rrule: 'FREQ=DAILY;BYHOUR=18;BYMINUTE=15;BYSECOND=0',
      providerThreadId: '01a145f6-aef5-7982-83f0-a944d36b50c8',
      createdAt: 1792175750128,
      updatedAt: 1792175750128,
      schedule: { understood: true, summary: 'Every day at 18:15', timeZone: 'America/New_York', nextRunAt: localTime(18, 18, 15) },
    }],
    readAt: FROM,
    partial: false,
    skipped: [],
  });
});

test('escaped quotes inside a prompt are decoded and unusable escapes are rejected', () => {
  const parsed = parseAutomationToml(replacePrompt(automation(), '"Ask for \\"status\\" and a\\nnewline."'));
  assert.equal(parsed.prompt, 'Ask for "status" and a\nnewline.');
  for (const prompt of ['"unterminated', '"bad \\q escape"', '"trailing" junk']) {
    assert.throws(() => parseAutomationToml(replacePrompt(automation(), prompt)), /line 10/, prompt);
  }
});

test('a malformed file fails closed and only that file is quarantined', async () => {
  const result = await createChatGPTAutomationsBridge(fakeHome({
    'kelby-research-evidence-and-daily-tests': automation(),
    'broken-file': 'version = 1\nid = "broken-file"\nname = "Broken"\n',
  })).handle({ action: 'chatgpt-automations-list' });
  assert.equal(result.rows.length, 1);
  assert.equal(result.partial, true);
  assert.deepEqual(result.skipped, ['broken-file']);
});

test('missing fields, unknown fields, repeated fields and richer TOML are rejected', () => {
  assert.throws(() => parseAutomationToml(automation().split('\n').filter((line) => !line.startsWith('prompt =')).join('\n')), /missing prompt/);
  assert.throws(() => parseAutomationToml(`${automation()}\nnotify = true`), /unknown field notify/);
  assert.throws(() => parseAutomationToml(`${automation()}\nstatus = "PAUSED"`), /repeated field status/);
  assert.throws(() => parseAutomationToml(automation().replace('version = 1', 'version = 1.5')), /line 1/);
  assert.throws(() => parseAutomationToml(automation().replace('version = 1', 'version = "1"')), /invalid automation fields: version/);
  assert.throws(() => parseAutomationToml(replacePrompt(automation(), '"""\nmulti\nline"""')), /line 10/);
  // A comment and a blank line are unambiguous in TOML and stay readable.
  assert.equal(parseAutomationToml(`# written by Codex\n\n${automation()}\n`).id, 'kelby-research-evidence-and-daily-tests');
});

test('schedule summaries cover the supported rules and never guess the rest', () => {
  const unknown = { understood: false, summary: '', timeZone: null, nextRunAt: null };
  assert.deepEqual(describeAutomationSchedule('FREQ=MINUTELY;INTERVAL=5', { from: FROM }),
    { understood: true, summary: 'Every 5 minutes', timeZone: null, nextRunAt: Date.parse('2026-10-18T12:05:00Z') });
  assert.deepEqual(describeAutomationSchedule('FREQ=MINUTELY', { from: FROM }),
    { understood: true, summary: 'Every minute', timeZone: null, nextRunAt: Date.parse('2026-10-18T12:01:00Z') });
  assert.deepEqual(describeAutomationSchedule('FREQ=HOURLY;INTERVAL=3', { from: FROM }),
    { understood: true, summary: 'Every 3 hours', timeZone: null, nextRunAt: Date.parse('2026-10-18T15:00:00Z') });
  assert.deepEqual(describeAutomationSchedule('RRULE:FREQ=WEEKLY;BYDAY=TU;BYHOUR=9;BYMINUTE=5', { from: FROM, timeZone: 'UTC' }),
    { understood: true, summary: 'Every Tuesday at 09:05', timeZone: 'UTC', nextRunAt: localTime(20, 9, 5) });
  assert.deepEqual(describeAutomationSchedule('FREQ=DAILY;BYHOUR=18;BYMINUTE=15;BYSECOND=30', { from: FROM }),
    { understood: true, summary: 'Every day at 18:15', timeZone: null, nextRunAt: null });
  // The cadence is readable, but the rule states no time, so no run is invented.
  assert.deepEqual(describeAutomationSchedule('FREQ=DAILY', { from: FROM }),
    { understood: true, summary: 'Every day', timeZone: null, nextRunAt: null });
  for (const rrule of ['FREQ=MONTHLY;BYDAY=1MO', 'FREQ=DAILY;COUNT=3', 'FREQ=WEEKLY;BYDAY=2MO;BYHOUR=9;BYMINUTE=0',
    'FREQ=WEEKLY;BYDAY=XX;BYHOUR=9;BYMINUTE=0', 'FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0', 'FREQ=DAILY;BYHOUR=25;BYMINUTE=0',
    'FREQ=MINUTELY;INTERVAL=0', 'FREQ=MINUTELY;INTERVAL=5;INTERVAL=10', 'INTERVAL=5', 'nonsense', '']) {
    assert.deepEqual(describeAutomationSchedule(rrule, { from: FROM }), unknown, rrule);
  }
});

test('rows sort by next run with unknown runs last, then by name', async () => {
  const bridge = createChatGPTAutomationsBridge(fakeHome({
    zeta: automation({ id: 'zeta', name: 'Zeta monthly', rrule: 'FREQ=MONTHLY' }),
    alpha: automation({ id: 'alpha', name: 'Alpha daily' }),
    middle: automation({ id: 'middle', name: 'Middle minute', rrule: 'FREQ=MINUTELY;INTERVAL=5' }),
  }));
  const names = ['Middle minute', 'Alpha daily', 'Zeta monthly'];
  assert.deepEqual((await bridge.handle({ action: 'chatgpt-automations-list' })).rows.map((row) => row.name), names);
  assert.deepEqual((await bridge.handle({ action: 'chatgpt-automations-list' })).rows.map((row) => row.name), names);
});

test('a failing directory read is an error result, never an authoritative empty list', async () => {
  const bridge = createChatGPTAutomationsBridge(fakeHome({}, { failure: Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) }));
  assert.deepEqual(await bridge.handle({ action: 'chatgpt-automations-list' }),
    { rows: [], readAt: FROM, partial: false, skipped: [], error: 'EACCES: permission denied' });
});

test('a missing automations directory is an explicit empty feed', async () => {
  const bridge = createChatGPTAutomationsBridge(fakeHome({}, { failure: Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }) }));
  assert.deepEqual(await bridge.handle({ action: 'chatgpt-automations-list' }), { rows: [], readAt: FROM, partial: false, skipped: [] });
});

test('a file whose id disagrees with its directory is quarantined', async () => {
  const result = await createChatGPTAutomationsBridge(fakeHome({
    'kelby-research-evidence-and-daily-tests': automation({ id: 'other-research-evidence-and-daily-tests' }),
  })).handle({ action: 'chatgpt-automations-list' });
  assert.deepEqual(result.rows, []);
  assert.equal(result.partial, true);
  assert.deepEqual(result.skipped, ['kelby-research-evidence-and-daily-tests']);
});

test('only the list action is dispatched', async () => {
  const bridge = createChatGPTAutomationsBridge(fakeHome({ 'kelby-research-evidence-and-daily-tests': automation() }));
  await assert.rejects(bridge.handle({ action: 'chatgpt-automations-run' }));
  await assert.rejects(bridge.handle({ action: 'chatgpt-automations-list', id: 'kelby-research-evidence-and-daily-tests' }));
});
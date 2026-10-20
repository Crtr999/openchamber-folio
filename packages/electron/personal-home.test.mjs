import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPersonalHome, parseBoardSource, quoteSqlIdentifier, notionPageId } from './personal-home.mjs';
import { createPersonalCalendar } from './personal-calendar.mjs';
const dailySourceUrl = 'collection://024860a0-3918-450b-93c0-074f9512c67e';
const habitSourceUrl = 'collection://f26696d5-a0fd-4add-a9ae-a7b48f4e2a15';
const source = (schema, url = dailySourceUrl) => `<data-source-state>${JSON.stringify({ url, name: 'Daily', schema })}</data-source-state>
<views><view url="{{view://${url.replace('collection://', '')}}}">${JSON.stringify({ dataSourceUrl: `{{${url}}}`, name: 'Integration', type: 'table', displayProperties: Object.values(schema).map((property) => property.name) })}</view></views>`;
const boardSource = source({ Name: { name: 'Task name', type: 'title' }, Status: { name: 'Status', type: 'status', groups: { complete: [{ name: 'Done' }], to_do: [{ name: 'To do' }], in_progress: [{ name: 'In progress' }] } } });
const habitsSource = source({ Day: { name: 'Day', type: 'title' }, Date: { name: 'Date', type: 'date' }, Pray: { name: 'Pray', type: 'checkbox' }, Formula: { name: 'Completion', type: 'formula', readOnly: true } }, habitSourceUrl);
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (text) => Buffer.from(`encrypted:${text}`), decryptString: (buffer) => buffer.toString().slice(10) };
async function fixture(options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'personal-home-test-'));
  const filePath = path.join(dir, 'settings.json');
  if (options.connected !== false) await writeFile(filePath, JSON.stringify({ token: safeStorage.encryptString(JSON.stringify({ access_token: 'test-access', refresh_token: 'test-refresh' })).toString('base64'), clientId: 'test-client', expiresAt: options.expired ? 1 : undefined }));
  const calls = []; let blocked = false; let authUrl;
  const fetchImpl = async (url, request) => {
    assert.equal(new URL(url).origin, 'https://mcp.notion.com'); assert.equal(request.redirect, 'error');
    if (url.endsWith('/register')) return Response.json({ client_id: 'test-client' });
    if (url.endsWith('/token')) { calls.push({ token: String(request.body) }); return Response.json({ access_token: 'new-test-access', refresh_token: 'new-test-refresh', expires_in: 3600 }); }
    const body = JSON.parse(request.body); calls.push(body);
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'initialize') return Response.json({ result: { protocolVersion: '2025-06-18' } });
    if (body.method === 'tools/list') { const names = ['get_tool_access', 'fetch', 'query_data_sources', 'update_page', 'create_pages', 'search', 'list_recent_pages', ...(options.deleteTool ? ['delete_page'] : [])]; const wraps = (name) => options.wrappedUpdates && (name === 'update_page' || name === 'query_data_sources' || name === 'delete_page'); return Response.json({ result: { tools: names.map((name) => { const advertised = { properties: name === 'delete_page' ? { page_id: { type: 'string' } } : {} }; return { name, inputSchema: wraps(name) ? { properties: { data: advertised } } : advertised }; }) } }); }
    const name = body.params.name;
    let result;
    if (name === 'get_tool_access') result = { current_tool_access: { query_data_sources: { status: 'available' } } };
    else if (name === 'fetch') result = { text: body.params.arguments.id.includes('f26696d5') ? habitsSource : options.boardSource ?? boardSource };
    else if (name === 'query_data_sources') {
      const data = body.params.arguments.data;
      assert.equal(data.mode, 'view');
      result = data.view_url.includes('f26696d5')
        ? { results: [{ url: 'https://www.notion.so/30813d2f13da8135850ecd155cf3b391', Day: 'Today', 'date:Date:start': '2026-10-06', Pray: '__NO__' }], has_more: false }
        : { results: [{ url: 'https://www.notion.so/28d13d2f13da80859015c65c62d969c6', 'Task name': 'Example', Status: 'To do',
          'date:Due:start': options.dates?.dueStart ?? null, 'date:Due:end': options.dates?.dueEnd ?? null, 'date:Due:is_datetime': options.dates?.dueIsDatetime ?? null }], has_more: false };
    }
    else if (name === 'search') result = { results: options.searchResults ?? [{ url: 'https://www.notion.so/Weekly-Planning-28d13d2f13da80859015c65c62d969c6', title: 'Weekly Planning', last_edited_time: '2026-10-19T12:00:00.000Z' }], has_more: false };
    else if (name === 'list_recent_pages') result = { results: options.recentResults ?? [] };
    else { if (name === 'update_page' && options.failMove) return Response.json({ result: { isError: true, content: [] } }); if ((name === 'update_page' || name === 'delete_page') && options.wrappedUpdates) { assert.deepEqual(Object.keys(body.params.arguments), ['data']); assert.match(body.params.arguments.data.page_id, /^[0-9a-f]{32}$/); } result = { saved: true }; }
    return Response.json({ result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
  };
  const service = createPersonalHome({ filePath, safeStorage, fetchImpl, isBlocked: () => blocked, openExternal: (url) => { authUrl = url; }, calendar: () => ({ access: 'unsupported' }) });
  return { service, calls, filePath, block: () => { blocked = true; }, authUrl: () => authUrl, clean: async () => { service.close(); await rm(dir, { recursive: true, force: true }); } };
}
test('Fetched status groups preserve workflow order and identifiers escape safely', () => {
  assert.deepEqual(parseBoardSource(boardSource).status.options.map((item) => item.name), ['To do', 'In progress', 'Done']);
  assert.equal(quoteSqlIdentifier('Task "name"'), '"Task ""name"""');
});
test('Stateless MCP initializes once; task writes require fetched membership and a valid status', async () => {
  const f = await fixture(); try {
    await assert.rejects(f.service.handle({ action: 'move', page: 'foreign', status: 'Done' }));
    const result = await f.service.handle({ action: 'board' }); assert.equal(result.rows[0].title, 'Example');
    await assert.rejects(f.service.handle({ action: 'move', page: result.rows[0].url, status: 'Invented' }));
    await f.service.handle({ action: 'move', page: result.rows[0].url, status: 'Done' });
    assert.equal(f.calls.filter((call) => call.method === 'initialize').length, 1);
    assert.deepEqual(f.calls.find((call) => call.params?.name === 'update_page').params.arguments.properties, { Status: 'Done' });
  } finally { await f.clean(); }
});
test('Habit view reads select the local day and only fetched checkbox fields can be written', async () => {
  const f = await fixture(); try {
    const result = await f.service.handle({ action: 'habits', day: '2026-10-06' });
    assert.equal(result.items[0].checked, false);
    await assert.rejects(f.service.handle({ action: 'habit', page: result.page, name: 'Completion', checked: true }));
    await f.service.handle({ action: 'habit', page: result.page, name: 'Pray', checked: true });
    assert.deepEqual(f.calls.find((call) => call.params?.name === 'query_data_sources').params.arguments.data, { mode: 'view', view_url: `view://${habitSourceUrl.replace('collection://', '')}`, page_size: 100 });
    assert.deepEqual(f.calls.find((call) => call.params?.name === 'update_page').params.arguments.properties, { Pray: '__YES__' });
  } finally { await f.clean(); }
});
test('Notion page search returns page metadata for the composer picker, never a page body', async () => {
  const f = await fixture(); try {
    const result = await f.service.handle({ action: 'search', query: 'planning' });
    assert.equal(result.connected, true);
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].title, 'Weekly Planning');
    assert.equal(result.pages[0].id, '28d13d2f13da80859015c65c62d969c6');
    assert.equal(result.pages[0].url, 'https://www.notion.so/28d13d2f13da80859015c65c62d969c6');
    assert.equal(result.pages[0].lastEdited, '2026-10-19T12:00:00.000Z');
    assert.equal(Object.keys(result.pages[0]).includes('content'), false);
    assert.deepEqual(f.calls.find((call) => call.params?.name === 'search').params.arguments, { query: 'planning', query_type: 'internal' });
  } finally { await f.clean(); }
});
test('Notion search drops results that are not pages and falls back to a title from the URL', async () => {
  const f = await fixture({ searchResults: [
    { url: 'https://www.notion.so/Quarterly-Notes-1a2b3c4d5e6f708192a3b4c5d6e7f809', title: 'Quarterly Notes' },
    { url: 'https://www.notion.so/Not-A-Page' },
  ] }); try {
    const result = await f.service.handle({ action: 'search', query: 'notes' });
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].title, 'Quarterly Notes');
  } finally { await f.clean(); }
});
test('An empty Notion query lists recently opened pages', async () => {
  const f = await fixture({ recentResults: [{ url: 'https://www.notion.so/28d13d2f13da80859015c65c62d969c6', title: 'Example' }] }); try {
    const result = await f.service.handle({ action: 'search', query: '' });
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].title, 'Example');
    assert.equal(f.calls.find((call) => call.params?.name === 'list_recent_pages') !== undefined, true);
  } finally { await f.clean(); }
});
test('A disconnected Notion reports itself instead of an empty result set', async () => {
  const f = await fixture({ connected: false }); try {
    const result = await f.service.handle({ action: 'search', query: 'planning' });
    assert.deepEqual(result, { connected: false, pages: [] });
    assert.equal(f.calls.length, 0);
  } finally { await f.clean(); }
});
test('Enterprise policy refuses every Notion entry before network egress; Calendar and disconnect remain available', async () => {
  const f = await fixture(); try {
    f.block();
    for (const action of ['status', 'connect', 'configure', 'search', 'board', 'habits', 'habit', 'start-day', 'move', 'create-task', 'rename-task', 'delete-task', 'export']) await assert.rejects(f.service.handle({ action }), /enterprise/);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.service.handle({ action: 'calendar', op: 'read' })).access, 'unsupported');
    await f.service.handle({ action: 'disconnect' });
    assert.equal(JSON.parse(await readFile(f.filePath)).token, undefined);
  } finally { await f.clean(); }
});
test('Expired credentials rotate once for concurrent reads and are persisted encrypted', async () => {
  const f = await fixture({ expired: true }); try {
    await Promise.all([f.service.handle({ action: 'board' }), f.service.handle({ action: 'board' })]);
    assert.equal(f.calls.filter((call) => call.token).length, 1);
    const stored = JSON.parse(await readFile(f.filePath));
    assert.equal(stored.token.includes('new-test-refresh'), false);
    assert.equal(JSON.parse(safeStorage.decryptString(Buffer.from(stored.token, 'base64'))).refresh_token, 'new-test-refresh');
  } finally { await f.clean(); }
});
test('OAuth validates state before exchanging and keeps credentials out of renderer status', async () => {
  const f = await fixture({ connected: false }); try {
    await f.service.handle({ action: 'connect' });
    const auth = new URL(f.authUrl()); assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    const callback = new URL(auth.searchParams.get('redirect_uri')); callback.searchParams.set('code', 'test-code'); callback.searchParams.set('state', 'wrong');
    assert.equal((await fetch(callback)).status, 400); assert.equal(f.calls.length, 0);
    callback.searchParams.set('state', auth.searchParams.get('state'));
    assert.equal((await fetch(callback)).status, 200);
    const status = await f.service.handle({ action: 'status' }); assert.equal(status.connected, true); assert.equal(JSON.stringify(status).includes('test-access'), false);
  } finally { await f.clean(); }
});
test('Calendar adapter rejects arbitrary operations and reports unsupported runtimes without launching a helper', async () => {
  const calendar = createPersonalCalendar({ executable: '/missing', platform: 'linux' });
  assert.deepEqual(await calendar({ op: 'read' }), { access: 'unsupported' });
  await assert.rejects(calendar({ op: 'delete' }));
});

test('Hosted MCP updates use the advertised data wrapper for both tasks and habits', async () => {
  const f = await fixture({ wrappedUpdates: true }); try {
    const board = await f.service.handle({ action: 'board' });
    await f.service.handle({ action: 'move', page: board.rows[0].url, status: 'Done' });
    const habits = await f.service.handle({ action: 'habits', day: '2026-10-06' });
    await f.service.handle({ action: 'habit', page: habits.page, name: 'Pray', checked: false });
    const writes = f.calls.filter((call) => call.params?.name === 'update_page');
    assert.deepEqual(writes.map((call) => call.params.arguments.data.properties), [{ Status: 'Done' }, { Pray: '__NO__' }]);
    assert.equal(f.calls.find((call) => call.params?.name === 'query_data_sources').params.arguments.data.mode, 'view');
  } finally { await f.clean(); }
});
test('Tasks create, rename and delete only against a fetched board', async () => {
  const f = await fixture({ deleteTool: true }); try {
    await assert.rejects(f.service.handle({ action: 'rename-task', page: 'https://www.notion.so/28d13d2f13da80859015c65c62d969c6', title: 'Renamed' }), /Refresh the board/);
    await assert.rejects(f.service.handle({ action: 'create-task', title: '   ' }));
    await f.service.handle({ action: 'create-task', title: 'Fresh task' });
    const created = f.calls.find((call) => call.params?.name === 'create_pages');
    assert.equal(created.params.arguments.parent.data_source_id, dailySourceUrl.replace('collection://', ''));
    assert.deepEqual(created.params.arguments.pages[0].properties, { 'Task name': 'Fresh task', Status: 'To do' });
    await assert.rejects(f.service.handle({ action: 'delete-task', page: 'https://www.notion.so/28d13d2f13da80859015c65c62d969c6', confirmed: true }), /Refresh the board/);
    const board = await f.service.handle({ action: 'board' });
    await assert.rejects(f.service.handle({ action: 'rename-task', page: 'foreign', title: 'Renamed' }), /Refresh the board/);
    await assert.rejects(f.service.handle({ action: 'delete-task', page: 'foreign', confirmed: true }), /Refresh the board/);
    await assert.rejects(f.service.handle({ action: 'create-task', title: 'Bad status', status: 'Invented' }), /status/);
    await f.service.handle({ action: 'rename-task', page: board.rows[0].url, title: 'Renamed' });
    assert.deepEqual(f.calls.filter((call) => call.params?.name === 'update_page').at(-1).params.arguments.properties, { 'Task name': 'Renamed' });
    await assert.rejects(f.service.handle({ action: 'delete-task', page: board.rows[0].url, confirmed: true }), /Refresh the board/);
    await f.service.handle({ action: 'board' });
    await f.service.handle({ action: 'delete-task', page: board.rows[0].url, confirmed: true });
    assert.equal(f.calls.filter((call) => call.params?.name === 'delete_page').at(-1).params.arguments.page_id, '28d13d2f13da80859015c65c62d969c6');
    await assert.rejects(f.service.handle({ action: 'rename-task', page: board.rows[0].url, title: 'Again' }), /Refresh the board/);
  } finally { await f.clean(); }
});
test('Deleting a task reports a clear error when the connection exposes no delete tool', async () => {
  const f = await fixture(); try {
    const board = await f.service.handle({ action: 'board' });
    await assert.rejects(f.service.handle({ action: 'delete-task', page: board.rows[0].url, confirmed: true }), /does not allow deleting tasks/);
    assert.equal(f.calls.some((call) => call.params?.name === 'delete_page'), false);
  } finally { await f.clean(); }
});
test('Hosted MCP wraps a delete call in data without rewrapping query arguments', async () => {
  const f = await fixture({ wrappedUpdates: true, deleteTool: true }); try {
    const board = await f.service.handle({ action: 'board' });
    await f.service.handle({ action: 'delete-task', page: board.rows[0].url, confirmed: true });
    assert.equal(f.calls.find((call) => call.params?.name === 'query_data_sources').params.arguments.data.mode, 'view');
    const removed = f.calls.find((call) => call.params?.name === 'delete_page');
    assert.deepEqual(Object.keys(removed.params.arguments), ['data']);
    assert.equal(removed.params.arguments.data.page_id, '28d13d2f13da80859015c65c62d969c6');
  } finally { await f.clean(); }
});
test('Page identifiers normalize copied links without treating view IDs as page IDs', () => {
  assert.equal(notionPageId('https://www.notion.so/Task-30813d2f13da8135850ecd155cf3b391?view=another'), '30813d2f13da8135850ecd155cf3b391');
  assert.equal(notionPageId('30813d2f-13da-8135-850e-cd155cf3b391'), '30813d2f-13da-8135-850e-cd155cf3b391');
  assert.throws(() => notionPageId('https://www.notion.so/not-a-page?view=30813d2f13da8135850ecd155cf3b391'));
});

test('Board due dates use the real date property and retain calendar days, offsets and ranges', async () => {
  const schema = { Name: { name: 'Task name', type: 'title' }, Status: { name: 'Status', type: 'status', options: [{ name: 'To do' }, { name: 'Worked Today' }, { name: 'Done/Archived' }] }, Due: { name: 'Due', type: 'date' }, Started: { name: 'Started', type: 'date' } };
  for (const dates of [{ dueStart: '2026-10-08', dueEnd: null, dueIsDatetime: 0 }, { dueStart: '2026-10-08T23:30:00-07:00', dueEnd: '2026-10-09T01:00:00-07:00', dueIsDatetime: 1 }, { dueStart: null, dueEnd: null, dueIsDatetime: null }]) {
    const f = await fixture({ boardSource: source(schema), dates });
    try {
      const board = await f.service.handle({ action: 'board' });
      assert.deepEqual(board.columns, ['To do', 'Worked Today', 'Done/Archived']);
      assert.deepEqual(board.rows[0].due, dates.dueStart ? { start: dates.dueStart, end: dates.dueEnd, isDatetime: dates.dueIsDatetime === 1 } : null);
      const query = f.calls.find((call) => call.params?.name === 'query_data_sources').params.arguments.data;
      assert.equal(query.mode, 'view');
      assert.equal(query.query, undefined);
      await f.service.handle({ action: 'move', page: board.rows[0].url, status: 'Worked Today' });
      await f.service.handle({ action: 'move', page: board.rows[0].url, status: 'Done\/Archived' });
      assert.deepEqual(f.calls.filter((call) => call.params?.name === 'update_page').map((call) => call.params.arguments.properties), [{ Status: 'Worked Today' }, { Status: 'Done/Archived' }]);
    } finally { await f.clean(); }
  }
});
test('Absent or ambiguous dates are not synthesized; failed moves leave fetched membership usable', async () => {
  const parsed = parseBoardSource(source({ Name: { name: 'Name', type: 'title' }, Status: { name: 'Status', type: 'status', options: [{ name: 'To do' }] }, A: { name: 'Started', type: 'date' }, B: { name: 'Finished', type: 'date' } }));
  assert.equal(parsed.due, null);
  const f = await fixture({ failMove: true });
  try {
    const board = await f.service.handle({ action: 'board' });
    assert.equal(board.rows[0].due, null);
    assert.equal(f.calls.find((call) => call.params?.name === 'query_data_sources').params.arguments.data.mode, 'view');
    await assert.rejects(f.service.handle({ action: 'move', page: board.rows[0].url, status: 'Done' }), /Notion could not complete/);
    await assert.rejects(f.service.handle({ action: 'move', page: board.rows[0].url, status: 'Done' }), /Notion could not complete/);
  } finally { await f.clean(); }
});

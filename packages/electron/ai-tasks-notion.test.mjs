import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPersonalHome } from './personal-home.mjs';

const daily = 'collection://024860a0-3918-450b-93c0-074f9512c67e';
const ai = 'collection://c4e6150061294afbbfe3361496bff481';
const habitSource = 'collection://f26696d5-a0fd-4add-a9ae-a7b48f4e2a15';
const viewUrls = { [daily]: 'view://11111111-1111-1111-1111-111111111111', [ai]: 'view://22222222-2222-2222-2222-222222222222', [habitSource]: 'view://33333333-3333-3333-3333-333333333333' };
const page = 'https://www.notion.so/28d13d2f13da80859015c65c62d969c6';
const columns = ['Idea', 'Ready for AI', 'Doing', 'Done', 'Needs you', 'Parked'];
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (text) => Buffer.from(text), decryptString: (buffer) => buffer.toString() };
const source = (url) => `<data-source-state>${JSON.stringify({ url, name: url === ai ? 'AI Tasks' : 'Daily', schema: url === habitSource ? {
  Day: { name: 'Day', type: 'title' }, Date: { name: 'Date', type: 'date' }, Pray: { name: 'Pray', type: 'checkbox' },
} : {
  Task: { name: 'Task', type: 'title' }, Status: { name: 'Status', type: 'select', options: columns.map((name) => ({ name })) },
  Due: { name: 'Due', type: 'date' },
} })}</data-source-state>`;
async function fixture({ wrapped = false, accessStatus = 'available_with_limit', discoverDatabase = false, deleteSchema = { properties: { page_id: { type: 'string' } }, required: ['page_id'] }, deleteAccess = 'available' } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-notion-'));
  const filePath = path.join(dir, 'settings.json');
  await writeFile(filePath, JSON.stringify({ token: safeStorage.encryptString(JSON.stringify({ access_token: 'fixture' })).toString('base64') }));
  const writes = []; const queries = []; const calls = [];
  let status = 'Ready for AI'; let content = 'Research this topic. Preserve these instructions.';
  let blocked = false; let member = true; let truncated = false; let failAfterContent = false; let failAfterStatus = false;
  let viewPatch = {}; let missingView = false; let incomplete = false; let dailyRows = []; let habitRows = [];
  let pagination = false; let queryPatch = {}; let metadataTruncated = false; let wrongSource = false; let notionEscapes = false;
  let contentTransform = (value) => value; let contentWarnings = [];
  let referencePages = new Map(); let referenceResults = []; let searchPatch = {}; let failReferences = false;
  const databaseUrls = Object.fromEntries(Object.keys(viewUrls).map((url) => [url, `https://www.notion.so/${url.replace('collection://', '')}`]));
  const view = (url) => `<view url="{{${viewUrls[url]}}}">${JSON.stringify({ dataSourceUrl: `{{${url}}}`, name: 'Integration', type: 'table',
    displayProperties: url === habitSource ? ['Day', 'Date', 'Pray'] : ['Task', 'Status', 'Due'], ...viewPatch })}</view>`;
  const fetchImpl = async (url, request) => {
    assert.equal(new URL(url).origin, 'https://mcp.notion.com');
    const call = JSON.parse(request.body);
    calls.push(call);
    if (call.method === 'initialize') return Response.json({ result: {} });
    if (call.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (call.method === 'tools/list') return Response.json({ result: { tools: ['get_tool_access', 'fetch', 'search', 'query_data_sources', 'update_page', 'create_pages', 'create_database', 'delete_page'].map((name) => { const advertised = name === 'delete_page' ? deleteSchema : { properties: {} }; return { name, inputSchema: wrapped && !['fetch', 'get_tool_access'].includes(name) ? { properties: { data: advertised } } : advertised }; }) } });
    const name = call.params.name;
    const args = call.params.arguments.data ?? call.params.arguments;
    let result;
    if (name === 'get_tool_access') result = { current_tool_access: { query_data_sources: { status: accessStatus }, delete_page: { status: deleteAccess } } };
    else if (name === 'fetch') {
      if (referencePages.has(args.id)) {
        if (failReferences) return Response.json({ result: { isError: true } });
        result = referencePages.get(args.id);
      }
      else if ([daily, ai, habitSource].includes(args.id)) result = { text: source(wrongSource ? 'collection://foreign' : args.id) + (missingView || discoverDatabase ? '' : `<views>${view(args.id)}</views>`), url: databaseUrls[args.id], truncated: metadataTruncated };
      else if (Object.values(databaseUrls).includes(args.id)) {
        const url = Object.keys(databaseUrls).find((url) => databaseUrls[url] === args.id);
        result = { text: source(url) + (missingView ? '' : `<views>${view(url)}</views>`), truncated: metadataTruncated };
      }
      else if (Object.values(viewUrls).includes(args.id)) result = { text: view(Object.keys(viewUrls).find((url) => viewUrls[url] === args.id)), truncated: metadataTruncated };
      else if (args.id === page) result = { text: `<page><content>\n${content}\n</content></page>`, truncated };
      else result = { text: 'Markdown specification' };
    } else if (name === 'search') {
      assert.deepEqual(args, { query: 'Legal Pro', query_type: 'internal' });
      result = { results: referenceResults, has_more: false, ...searchPatch };
    } else if (name === 'query_data_sources') {
      queries.push(args);
      assert.equal(args.mode, 'view', 'SQL/rows quota is exhausted; only view mode may run');
      assert.equal(args.page_size, 100);
      assert.deepEqual(Object.keys(args).sort(), (args.start_cursor ? ['mode', 'page_size', 'start_cursor', 'view_url'] : ['mode', 'page_size', 'view_url']).sort());
      const own = args.view_url === viewUrls[ai];
      result = { results: own && member ? [{ url: page, Task: 'Research', Status: status }] : args.view_url === viewUrls[daily] ? dailyRows : args.view_url === viewUrls[habitSource] ? habitRows : [], has_more: incomplete, ...queryPatch };
      if (pagination && !args.start_cursor) result = { results: [], has_more: true, next_cursor: 'second-page' };
    } else if (name === 'update_page') {
      writes.push(args);
      if (args.command === 'update_properties') {
        status = args.properties.Status;
        if (failAfterStatus) { failAfterStatus = false; return Response.json({ result: { isError: true } }); }
      } else if (args.command === 'update_content') {
        assert.equal(args.content_updates[0].old_str, content);
        content = args.content_updates[0].new_str;
        if (notionEscapes) content = content.replace(/\$/g, '\\$').replace(/\n\n/g, '\n<empty-block/>\n');
        content = contentTransform(content);
        if (failAfterContent) { failAfterContent = false; return Response.json({ result: { isError: true } }); }
      } else if (args.command === 'replace_content') {
        assert.equal(content.trim(), '', 'Whole-body replacement is only valid for an authoritative empty page');
        content = args.new_str;
      } else assert.fail('Unexpected destructive content command');
      result = { saved: true };
      if (args.command === 'update_content' && contentWarnings.length) result.warnings = contentWarnings;
    } else if (name === 'create_database') { writes.push(args); result = { text: source(ai) }; }
    else { writes.push(args); result = { saved: true }; }
    return Response.json({ result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
  };
  const service = createPersonalHome({ filePath, safeStorage, openExternal: () => {}, calendar: () => {}, fetchImpl, isBlocked: () => blocked });
  return {
    notion: service.automation, service, writes, queries, calls,
    status: () => status, content: () => content,
    setStatus: (value) => { status = value; }, clear: () => { content = ''; }, block: () => { blocked = true; },
    remove: () => { member = false; }, truncate: () => { truncated = true; }, failContent: () => { failAfterContent = true; }, failStatus: () => { failAfterStatus = true; },
    filter: (patch) => { viewPatch = patch; }, missingView: () => { missingView = true; }, incomplete: () => { incomplete = true; },
    paginate: () => { pagination = true; }, queryPatch: (patch) => { queryPatch = patch; }, truncateMetadata: () => { metadataTruncated = true; },
    daily: (rows) => { dailyRows = rows; }, habits: (rows) => { habitRows = rows; },
    wrongSource: () => { wrongSource = true; }, escapeLikeNotion: () => { notionEscapes = true; },
    transformContent: (transform) => { contentTransform = transform; }, setContent: (value) => { content = value; },
    warnContent: () => { contentWarnings = [{ code: 'update_warning', message: 'Input was dropped.' }]; },
    references: (pages, results = [...pages.keys()].map((url) => ({ url })), patch = {}) => { referencePages = pages; referenceResults = results; searchPatch = patch; },
    denyReferences: () => { failReferences = true; },
    close: async () => { service.close(); await rm(dir, { recursive: true, force: true }); },
  };
}
const run = { id: 'run1', board: ai, page, sessionId: 'ses_test', outcome: 'done', content: 'DONE\nThe deliverable.' };

test('Notion loading request-count measurement', async (t) => {
  const f = await fixture(); try {
    await f.notion.readBoard(ai);
    const cold = f.calls.length;
    await f.notion.readBoard(ai);
    const warm = f.calls.length - cold;
    const before = f.calls.length;
    const results = await Promise.all([f.notion.readBoard(ai), f.notion.readBoard(ai)]);
    assert.equal(results[0].rows.length, 1); assert.equal(results[1].rows.length, 1);
    t.diagnostic(JSON.stringify({ cold, warm, concurrent: f.calls.length - before }));
    assert.deepEqual({ cold, warm, concurrent: f.calls.length - before }, { cold: 8, warm: 2, concurrent: 2 });
    const mixedBefore = f.calls.length;
    const mixed = await Promise.all([f.notion.readBoard(ai), f.notion.readBoard(ai, 'Idea')]);
    assert.equal(mixed[0].rows.length, 1); assert.equal(mixed[1].rows.length, 0);
    assert.equal(f.calls.length - mixedBefore, 2);
  } finally { await f.close(); }
});

const noteUrl = 'https://www.notion.so/11111111111111111111111111111111';
const secondNoteUrl = 'https://www.notion.so/22222222222222222222222222222222';
const note = (url = noteUrl, title = 'Legal Pro', location = 'Villanova Law Dashboard', content = '# Assignment 1\nRead the assigned cases and draft the coursework answer.') => ({
  text: `<page url="{{${url}}}"><ancestor-path><ancestor-page url="{{https://www.notion.so/33333333333333333333333333333333}}" title="${location}"/></ancestor-path><properties>${JSON.stringify({ title })}</properties><content>${content}</content></page>`,
});

test('explicit Notion links resolve through hosted fetch and preserve original notes, selector and prior-result separation', async () => {
  const f = await fixture(); try {
    const original = `Use ${noteUrl} for Assignment 1. Keep the answer concise.`;
    f.setContent(`${original}\n\n## Open Carter run old\nPrior output must not enter this brief.`);
    f.references(new Map([[noteUrl, note()]]));
    const brief = await f.notion.readTask(ai, page);
    assert.ok(brief.startsWith(`# Research\n\n${original}`));
    assert.match(brief, /Source title: Legal Pro/); assert.ok(brief.includes(`Source URL: ${noteUrl}`));
    assert.match(brief, /Requested selector: Assignment 1/); assert.match(brief, /Read the assigned cases/);
    assert.doesNotMatch(brief, /Prior output/); assert.equal(f.writes.length, 0);
    assert.equal(f.calls.some((call) => call.params?.name === 'search'), false);
  } finally { await f.close(); }
});

test('official app.notion.com browser links canonicalize their page identity before connected fetch', async () => {
  const browserUrl = 'https://app.notion.com/p/carterlaborde/Full-Tech-Stack-3f94fdbee450817895efc43cd0e73ff0';
  const canonicalUrl = 'https://www.notion.so/3f94fdbee450817895efc43cd0e73ff0';
  for (const original of [browserUrl, browserUrl.replace('app.notion.com', 'notion.com')]) {
    const f = await fixture(); try {
      f.setContent(`Use ${original} for Assignment 1.`);
      f.references(new Map([[canonicalUrl, note(canonicalUrl, 'Full Tech Stack')]]));
      const brief = await f.notion.readTask(ai, page);
      assert.ok(brief.includes(original)); assert.ok(brief.includes(`Source URL: ${canonicalUrl}`));
      assert.match(brief, /Source title: Full Tech Stack/);
      assert.equal(f.calls.filter((call) => call.params?.name === 'fetch' && call.params.arguments.id === canonicalUrl).length, 1);
      assert.equal(f.calls.some((call) => call.params?.arguments?.id === original), false);
      assert.equal(f.writes.length, 0);
      f.denyReferences(); await assert.rejects(f.notion.readTask(ai, page), (error) => error.code === 'notion_reference_access');
    } finally { await f.close(); }
  }
  const mismatched = await fixture(); try {
    mismatched.setContent(`${browserUrl}, Assignment 1`);
    mismatched.references(new Map([[canonicalUrl, note(noteUrl, 'Full Tech Stack')]]));
    await assert.rejects(mismatched.notion.readTask(ai, page), (error) => error.code === 'notion_reference_scope');
    assert.equal(mismatched.writes.length, 0);
  } finally { await mismatched.close(); }
});

test('Notion site and unsupported subdomains fail explicitly; spoof hosts never become connected fetch targets', async () => {
  for (const host of ['notion.site', 'private.notion.so', 'private.notion.com']) {
    const f = await fixture(); try {
      f.setContent(`Use https://${host}/11111111111111111111111111111111 for Assignment 1.`);
      await assert.rejects(f.notion.readTask(ai, page), (error) => error.code === 'notion_reference_url');
      assert.equal(f.calls.some((call) => call.params?.arguments?.id?.includes(host)), false);
      assert.equal(f.writes.length, 0);
    } finally { await f.close(); }
  }
  for (const host of ['app.notion.com.evil.test', 'notion.com.evil.test', 'evilnotion.com']) {
    const f = await fixture(); try {
      const url = `https://${host}/11111111111111111111111111111111`;
      f.setContent(`Use ${url} for Assignment 1.`);
      assert.doesNotMatch(await f.notion.readTask(ai, page), /Verified Notion reference/);
      assert.equal(f.calls.some((call) => call.params?.arguments?.id === url), false);
      assert.equal(f.writes.length, 0);
    } finally { await f.close(); }
  }
});

test('natural title and dashboard references require exact fetched title and location, not search snippets', async () => {
  for (const request of ['Legal Pro in the Villanova Law Dashboard, Assignment 1', 'Use the Notion note called "Legal Pro" in the Villanova Law Dashboard, Assignment 1']) {
    const f = await fixture(); try {
      f.setContent(request); f.references(new Map([[noteUrl, note()]]));
      const brief = await f.notion.readTask(ai, page);
      assert.match(brief, /Read the assigned cases/); assert.match(brief, /Requested selector: Assignment 1/);
      assert.equal(f.calls.filter((call) => call.params?.name === 'search').length, 1);
      assert.equal(f.writes.length, 0);
    } finally { await f.close(); }
  }
});

test('ordinary notes and title-only quick requests do not search or fetch unrelated pages', async () => {
  for (const request of ['', 'Legal Pro', 'Write a plan for Assignment 1.', 'Keep the legal analysis short.']) {
    const f = await fixture(); try {
      f.setContent(request);
      const brief = await f.notion.readTask(ai, page);
      assert.equal(brief, request ? `# Research\n\n${request}` : 'Research');
      assert.equal(f.calls.some((call) => call.params?.name === 'search'), false);
      assert.equal(f.calls.filter((call) => call.params?.name === 'fetch' && call.params.arguments.id === page).length, 1);
    } finally { await f.close(); }
  }
});

test('named reference ambiguity, missing title/location, incomplete search and denied access fail explicitly before dispatch', async () => {
  const scenarios = [
    { pages: new Map([[noteUrl, note()], [secondNoteUrl, note(secondNoteUrl)]]), code: 'notion_reference_ambiguous' },
    { pages: new Map(), code: 'notion_reference_missing' },
    { pages: new Map([[noteUrl, note(noteUrl, 'Other')]]), code: 'notion_reference_missing' },
    { pages: new Map([[noteUrl, note(noteUrl, 'Legal Pro', 'Other Dashboard')]]), code: 'notion_reference_missing' },
    { pages: new Map([[noteUrl, { ...note(), truncated: true }]]), code: 'notion_reference_incomplete' },
    { pages: new Map([[noteUrl, note()]]), patch: { has_more: true }, code: 'notion_reference_ambiguous' },
    { pages: new Map([[noteUrl, note()]]), patch: { has_more: undefined }, code: 'notion_reference_incomplete' },
    { pages: new Map([[noteUrl, note()]]), denied: true, code: 'notion_reference_access' },
  ];
  for (const scenario of scenarios) {
    const f = await fixture(); try {
      f.setContent('Legal Pro in the Villanova Law Dashboard, Assignment 1');
      f.references(scenario.pages, undefined, scenario.patch); if (scenario.denied) f.denyReferences();
      await assert.rejects(f.notion.readTask(ai, page), (error) => error.code === scenario.code);
      assert.equal(f.writes.length, 0);
    } finally { await f.close(); }
  }
});

test('reference URLs cannot cause arbitrary network access; wrong page identities and missing content fail closed', async () => {
  for (const bad of ['https://notion.so.evil.test/11111111111111111111111111111111', 'https://example.test/source']) {
    const f = await fixture(); try {
      f.setContent(`Use ${bad} for Assignment 1`);
      // Ordinary external links remain text for the chosen provider, never host fetches.
      assert.doesNotMatch(await f.notion.readTask(ai, page), /Verified Notion reference/);
      assert.equal(f.calls.some((call) => call.params?.arguments?.id === bad), false);
    } finally { await f.close(); }
  }
  for (const payload of [note(secondNoteUrl), { text: '<page><content>Incomplete</content></page>' }, note(noteUrl, 'Legal Pro', 'Villanova Law Dashboard', '')]) {
    const f = await fixture(); try {
      f.setContent(`${noteUrl}, Assignment 1`); f.references(new Map([[noteUrl, payload]]));
      await assert.rejects(f.notion.readTask(ai, page), /verify|readable/); assert.equal(f.writes.length, 0);
    } finally { await f.close(); }
  }
});

test('child source context is fetched within bounds; incomplete children do not become missing-success', async () => {
  const f = await fixture(); try {
    f.setContent(`${noteUrl}, Assignment 1`);
    const parent = note(noteUrl, 'Legal Pro', 'Villanova Law Dashboard', `Assignment 1 instructions\n<page url="{{${secondNoteUrl}}}">Cases</page>`);
    const child = note(secondNoteUrl, 'Cases', 'Legal Pro', 'The actual assigned case text.');
    child.text = child.text.replace('https://www.notion.so/33333333333333333333333333333333', noteUrl);
    f.references(new Map([[noteUrl, parent], [secondNoteUrl, child]]));
    assert.match(await f.notion.readTask(ai, page), /The actual assigned case text/);
    f.references(new Map([[noteUrl, parent], [secondNoteUrl, { ...note(secondNoteUrl, 'Cases', 'Legal Pro'), truncated: true }]]));
    await assert.rejects(f.notion.readTask(ai, page), /incomplete/);
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test('AI trash requires consent, fresh membership and non-Doing status, using advertised singular/plural wrapped schema', async () => {
  for (const wrapped of [false, true]) for (const plural of [false, true]) {
    const key = plural ? 'page_ids' : 'page_id';
    const f = await fixture({ wrapped, deleteSchema: { properties: { [key]: plural ? { type: 'array', items: { type: 'string' } } : { type: 'string' }, confirm: { type: 'boolean', const: true } }, required: [key, 'confirm'] } }); try {
      f.setStatus('Idea');
      await assert.rejects(f.notion.delete(ai, { page })); assert.equal(f.calls.length, 0);
      await assert.rejects(f.notion.delete(ai, { page: noteUrl, confirmed: true }), /no longer/);
      f.setStatus('Doing'); await assert.rejects(f.notion.delete(ai, { page, confirmed: true }), /running/);
      f.setStatus('Done'); assert.deepEqual(await f.notion.delete(ai, { page, confirmed: true }), { saved: true });
      const removed = f.calls.filter((call) => call.params?.name === 'delete_page'); assert.equal(removed.length, 1);
      assert.deepEqual(removed[0].params.arguments, wrapped ? { data: { [key]: plural ? [page.slice(-32)] : page.slice(-32), confirm: true } } : { [key]: plural ? [page.slice(-32)] : page.slice(-32), confirm: true });
    } finally { await f.close(); }
  }
});

test('AI trash refuses unsupported schema, access restrictions, removed membership and enterprise mode without deleting', async () => {
  for (const options of [{ deleteSchema: { properties: { arbitrary: {} } } }, { deleteSchema: { properties: { page_id: {} }, required: ['page_id', 'permanent'] } }, { deleteAccess: 'not_enabled' }]) {
    const f = await fixture(options); try {
      f.setStatus('Idea'); await assert.rejects(f.notion.delete(ai, { page, confirmed: true }));
      assert.equal(f.writes.length, 0);
    } finally { await f.close(); }
  }
  const f = await fixture(); try {
    await f.notion.readBoard(ai); f.remove();
    await assert.rejects(f.notion.delete(ai, { page, confirmed: true }), /no longer/);
    f.block(); await assert.rejects(f.notion.delete(ai, { page, confirmed: true }), /enterprise/);
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test('cached read metadata never authorizes writes and failed board loads are retried, not cached as empty', async () => {
  const f = await fixture(); try {
    await f.notion.readBoard(ai);
    f.truncateMetadata();
    await assert.rejects(f.notion.delete(ai, { page, confirmed: true }), /incomplete/);
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
  const broken = await fixture({ accessStatus: 'not_enabled' }); try {
    await assert.rejects(Promise.all([broken.notion.readBoard(ai), broken.notion.readBoard(ai)]));
    assert.equal(broken.calls.length, 7); // initialization + two sources + live view; query refused locally
    await assert.rejects(broken.notion.readBoard(ai));
    assert.equal(broken.calls.length, 10); // rejected metadata entries were cleared; retry performs all reads
    assert.equal(broken.queries.length, 0);
  } finally { await broken.close(); }
});

test('automation reads do not replace Daily To-Do cached membership and reject the personal database', async () => {
  const f = await fixture(); try {
    await f.service.handle({ action: 'board' });
    const board = await f.notion.readBoard(ai, 'Ready for AI'); assert.equal(board.rows.length, 1);
    await assert.rejects(f.notion.readBoard(daily), /separate database/);
    await assert.rejects(f.service.handle({ action: 'move', page, status: 'Done' }), /Refresh/);
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});
test('claims require fresh Ready membership; new cards start as ideas, not authorized work', async () => {
  const f = await fixture(); try {
    await f.notion.create(ai, { title: 'Idea' });
    assert.equal(f.writes[0].pages[0].properties.Status, 'Idea');
    assert.equal(await f.notion.claim(ai, page), true); assert.equal(f.status(), 'Doing');
    assert.equal(await f.notion.claim(ai, page), false);
    f.remove(); await assert.rejects(f.notion.readTask(ai, page), /no longer/);
  } finally { await f.close(); }
});
test('Notion result writeback preserves the description and confirms content before setting Done', async () => {
  const f = await fixture({ wrapped: true }); try {
    await f.notion.claim(ai, page);
    assert.equal(await f.notion.finish(run), true);
    assert.match(f.content(), /^Research this topic/); assert.match(f.content(), /openchamber:\/\/session\/ses_test/);
    assert.match(f.content(), /The deliverable/); assert.equal(f.status(), 'Done');
    assert.deepEqual(f.writes.map((write) => write.command), ['update_properties', 'update_content', 'update_properties']);
  } finally { await f.close(); }
});
test('ambiguous content and status responses reconcile without duplicating results', async () => {
  const f = await fixture(); try {
    await f.notion.claim(ai, page); f.failContent();
    await assert.rejects(f.notion.finish(run));
    f.failStatus(); await assert.rejects(f.notion.finish(run));
    assert.equal(await f.notion.finish(run), true);
    assert.equal(f.writes.filter((write) => write.command === 'update_content').length, 1);
    assert.equal(f.content().split('Open Carter run run1').length, 2);
  } finally { await f.close(); }
});
test('a user move cancels writeback; incomplete and cleared pages never get overwritten', async () => {
  const f = await fixture(); try {
    f.setStatus('Parked'); assert.equal(await f.notion.finish(run), false); assert.equal(f.writes.length, 0);
    f.setStatus('Doing'); f.clear(); await assert.rejects(f.notion.finish(run), /cleared/);
    // A title-only card is a valid quick request: the empty body falls back to the title.
    assert.ok((await f.notion.readTask(ai, page)).trim());
    f.truncate(); await assert.rejects(f.notion.readTask(ai, page), /incomplete/);
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});
test('board creation is private, uses the exact workflow, and parses the returned data source', async () => {
  const f = await fixture(); try {
    assert.equal(await f.notion.createBoard(), ai);
    assert.equal(f.writes[0].parent, undefined);
    for (const column of columns) assert.ok(f.writes[0].schema.includes(`'${column}'`));
  } finally { await f.close(); }
});
test('enterprise policy blocks every automation adapter entry before network requests', async () => {
  const f = await fixture(); try {
    f.block();
    for (const action of [() => f.notion.createBoard(), () => f.notion.readBoard(ai), () => f.notion.readTask(ai, page), () => f.notion.claim(ai, page), () => f.notion.create(ai, { title: 'Task' }), () => f.notion.move(ai, page, 'Ready for AI'), () => f.notion.finish(run)]) await assert.rejects(action(), /enterprise/);
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test('limited access and exhausted SQL use only saved views, including paginated claim and writeback membership', async () => {
  const f = await fixture({ wrapped: true }); try {
    f.paginate();
    const board = await f.notion.readBoard(ai, 'Ready for AI');
    assert.equal(board.rows.length, 1); assert.equal(board.limited, false);
    assert.equal(await f.notion.claim(ai, page), true);
    assert.equal(await f.notion.finish(run), true);
    assert.ok(f.queries.some((query) => query.start_cursor === 'second-page'));
    assert.ok(f.queries.every((query) => query.mode === 'view'));
  } finally { await f.close(); }
});

test('view reads remain usable when access metadata describes a SQL plan restriction; not_enabled stays blocked', async () => {
  for (const accessStatus of ['plan_required', 'upgrade_required', 'full_version_required']) {
    const f = await fixture({ accessStatus }); try {
      assert.equal((await f.notion.readBoard(ai)).rows.length, 1);
    } finally { await f.close(); }
  }
  const f = await fixture({ accessStatus: 'not_enabled' }); try {
    await assert.rejects(f.notion.readBoard(ai), /does not allow/);
    assert.equal(f.queries.length, 0);
  } finally { await f.close(); }
});

test('missing, filtered, wrong-source and hidden-property views fail before queries or writes', async () => {
  for (const change of [f => f.missingView(), f => f.filter({ simpleFilters: [{ filter: { property: 'Status' } }] }),
    f => f.filter({ dataSourceUrl: 'collection://foreign' }), f => f.filter({ displayProperties: ['Task'] }),
    f => f.filter({ groupBy: { hiddenGroups: ['Done'] } }), f => f.truncateMetadata()]) {
    const f = await fixture(); try {
      change(f);
      await assert.rejects(f.notion.claim(ai, page), /unfiltered|incomplete/);
      await assert.rejects(f.notion.finish(run), /unfiltered|incomplete/);
      await assert.rejects(f.service.handle({ action: 'board' }), /unfiltered|incomplete/);
      await assert.rejects(f.service.handle({ action: 'start-day', day: '2026-10-13' }), /unfiltered|incomplete/);
      assert.equal(f.writes.length, 0); assert.equal(f.queries.length, 0);
    } finally { await f.close(); }
  }
});

test('incomplete query responses never authorize absence, claims, writeback or habit creation', async () => {
  for (const patch of [{ has_more: true }, { truncated: true }, { has_more: undefined },
    { notices: ['Restriction'] }, { has_more: true, next_cursor: 'repeated' }, { next_cursor: 'unexpected' }]) {
    const f = await fixture(); try {
      f.queryPatch(patch);
      await assert.rejects(f.notion.claim(ai, page), /incomplete/);
      await assert.rejects(f.notion.finish(run), /incomplete/);
      await assert.rejects(f.service.handle({ action: 'start-day', day: '2026-10-13' }), /incomplete/);
      assert.equal(f.writes.length, 0);
    } finally { await f.close(); }
  }
});

test('Daily To-Do view reads retain due dates and fresh membership for move and rename', async () => {
  const f = await fixture(); try {
    const due = { start: '2026-10-13T23:30:00-07:00', end: '2026-10-14T01:00:00-07:00', isDatetime: true };
    f.daily([{ url: page, Task: 'Daily task', Status: 'Idea', 'date:Due:start': due.start, 'date:Due:end': due.end, 'date:Due:is_datetime': 1 }]);
    const board = await f.service.handle({ action: 'board' });
    assert.deepEqual(board.rows[0].due, due); assert.equal(board.limited, false);
    await f.service.handle({ action: 'move', page, status: 'Done' });
    assert.deepEqual(f.writes[0].properties, { Status: 'Done' });
    f.daily([]);
    await assert.rejects(f.service.handle({ action: 'rename-task', page, title: 'Moved elsewhere' }), /Refresh/);
    assert.equal(f.writes.length, 1);
  } finally { await f.close(); }
});

test('habits filter the complete view by local day, detect duplicates and refresh checkbox membership', async () => {
  const f = await fixture(); try {
    const today = { url: page, Day: 'Today', 'date:Date:start': '2026-10-13', Pray: '__YES__' };
    f.habits([today, { ...today, url: 'https://www.notion.so/30813d2f13da8135850ecd155cf3b391', 'date:Date:start': '2026-10-12' }]);
    const habits = await f.service.handle({ action: 'habits', day: '2026-10-13' });
    assert.deepEqual(habits.items, [{ name: 'Pray', checked: true }]);
    await f.service.handle({ action: 'habit', page, name: 'Pray', checked: false });
    assert.deepEqual(f.writes[0].properties, { Pray: '__NO__' });
    f.habits([]);
    await assert.rejects(f.service.handle({ action: 'habit', page, name: 'Pray', checked: true }), /Refresh/);
    assert.equal(f.writes.length, 1);
    f.habits([today, { ...today, url: 'https://www.notion.so/30813d2f13da8135850ecd155cf3b391' }]);
    await assert.rejects(f.service.handle({ action: 'start-day', day: '2026-10-13' }), /more than one/);
    assert.equal(f.writes.length, 1);
  } finally { await f.close(); }
});

test('fresh filtered metadata invalidates previously fetched habit and Daily To-Do write membership', async () => {
  const f = await fixture(); try {
    f.daily([{ url: page, Task: 'Daily', Status: 'Idea' }]);
    f.habits([{ url: page, Day: 'Today', 'date:Date:start': '2026-10-13', Pray: '__NO__' }]);
    await f.service.handle({ action: 'board' });
    await f.service.handle({ action: 'habits', day: '2026-10-13' });
    f.filter({ simpleFilters: [{ filter: { property: 'Date' } }] });
    await assert.rejects(f.service.handle({ action: 'move', page, status: 'Done' }), /unfiltered/);
    await assert.rejects(f.service.handle({ action: 'habit', page, name: 'Pray', checked: true }), /unfiltered/);
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test('collection selections discover saved views from the returned database URL without changing selections', async () => {
  const f = await fixture({ discoverDatabase: true }); try {
    const before = await f.service.handle({ action: 'status' });
    assert.equal((await f.notion.readBoard(ai)).rows.length, 1);
    assert.equal((await f.service.handle({ action: 'board' })).limited, false);
    assert.equal((await f.service.handle({ action: 'habits', day: '2026-10-13' })).page, null);
    assert.deepEqual(await f.service.handle({ action: 'status' }), before);
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test('wrong-source metadata cannot replace authorized Daily, habit or AI source membership', async () => {
  const f = await fixture(); try {
    f.daily([{ url: page, Task: 'Daily', Status: 'Idea' }]);
    f.habits([{ url: page, Day: 'Today', 'date:Date:start': '2026-10-13', Pray: '__NO__' }]);
    await f.service.handle({ action: 'board' });
    await f.service.handle({ action: 'habits', day: '2026-10-13' });
    f.wrongSource();
    for (const action of [() => f.service.handle({ action: 'move', page, status: 'Done' }),
      () => f.service.handle({ action: 'habit', page, name: 'Pray', checked: true }),
      () => f.notion.claim(ai, page), () => f.notion.finish(run)]) await assert.rejects(action(), /different data source/);
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});

test('duplicate pages across pagination fail closed rather than presenting or authorizing a partial board', async () => {
  const f = await fixture(); try {
    f.queryPatch({ has_more: true, next_cursor: 'next' });
    await assert.rejects(f.notion.readBoard(ai), /incomplete/);
    await assert.rejects(f.notion.claim(ai, page), /incomplete/);
    assert.equal(f.writes.length, 0);
  } finally { await f.close(); }
});
test('card notes are the manager brief: prompts are stripped, title leads, running cards are locked', async () => {
  const f = await fixture(); try {
    await f.notion.create(ai, { title: 'Quick', notes: '  Use the Q3 numbers.  ' });
    assert.equal(f.writes.at(-1).pages[0].content, 'Use the Q3 numbers.');
    await f.notion.create(ai, { title: 'Bare' });
    // The body is never empty, so result writeback keeps an anchor.
    assert.ok(f.writes.at(-1).pages[0].content.trim());
    f.setStatus('Idea');
    await f.notion.saveNotes(ai, { page, notes: 'Describe the task and the expected deliverable here.' });
    assert.deepEqual(await f.notion.readNotes(ai, page), { notes: '', editable: true });
    assert.equal(await f.notion.readTask(ai, page), 'Research');
    await f.notion.saveNotes(ai, { page, notes: 'Compare three vendors.\nSave a table.' });
    assert.equal(f.content(), 'Compare three vendors.\nSave a table.');
    assert.equal(await f.notion.readTask(ai, page), '# Research\n\nCompare three vendors.\nSave a table.');
    f.setStatus('Doing');
    assert.equal((await f.notion.readNotes(ai, page)).editable, false);
    const before = f.writes.length;
    await assert.rejects(f.notion.saveNotes(ai, { page, notes: 'Changed mid-run' }), /running/);
    assert.equal(f.writes.length, before);
  } finally { await f.close(); }
});
test('notes Notion reformats ($ escapes, empty blocks) still save, read back plain and do not rewrite', async () => {
  const f = await fixture(); try {
    f.setStatus('Idea'); f.escapeLikeNotion();
    const notes = 'Eligible for up to $250,000 in deposit insurance.\n\nwould become an issue if the bank fails...';
    await f.notion.saveNotes(ai, { page, notes });
    assert.match(f.content(), /\\\$250,000/);
    assert.deepEqual(await f.notion.readNotes(ai, page), { notes, editable: true });
    const before = f.writes.length;
    await f.notion.saveNotes(ai, { page, notes });
    assert.equal(f.writes.length, before);
  } finally { await f.close(); }
});
test('Notion line breaks roundtrip without false failure or another content write', async () => {
  const f = await fixture(); try {
    f.setStatus('Idea');
    f.transformContent((value) => value.replace(/\n/g, '<br>'));
    const notes = 'First requirement.\nSecond requirement.\n\nBudget $250,000.';
    await f.notion.saveNotes(ai, { page, notes });
    assert.equal((await f.notion.readNotes(ai, page)).notes, notes);
    const before = f.writes.length;
    await f.notion.saveNotes(ai, { page, notes });
    assert.equal(f.writes.length, before);
  } finally { await f.close(); }
});
test('a lost save acknowledgement reconciles by reading, never by repeating the write', async () => {
  const f = await fixture(); try {
    f.setStatus('Idea'); f.failContent();
    await f.notion.saveNotes(ai, { page, notes: 'Deliver a checked vendor comparison.' });
    assert.equal(f.writes.filter((write) => write.command === 'update_content').length, 1);
    assert.equal((await f.notion.readNotes(ai, page)).notes, 'Deliver a checked vendor comparison.');
  } finally { await f.close(); }
});
test('no-op checks retain word boundaries and literal code indentation and escapes', async () => {
  for (const [original, notes] of [
    ['Compare a b.', 'Compare ab.'],
    ['```python\nif ready:\n    submit()\n```', '```python\nif ready:\nsubmit()\n```'],
    ['```text\n\\$literal<br>\n```', '```text\n$literal<br>\n```'],
  ]) {
    const f = await fixture(); try {
      f.setStatus('Idea'); f.setContent(original);
      await f.notion.saveNotes(ai, { page, notes });
      assert.equal(f.writes.filter((write) => write.command === 'update_content').length, 1);
      assert.equal(f.content(), notes);
    } finally { await f.close(); }
  }
  const f = await fixture(); try {
    f.setContent('```text\n\\$literal<br>\n```');
    assert.equal((await f.notion.readNotes(ai, page)).notes, '```text\n\\$literal<br>\n```');
  } finally { await f.close(); }
});
test('a clean Notion acknowledgement saves despite canonicalized list numbering', async () => {
  const f = await fixture(); try {
    f.setStatus('Idea');
    f.transformContent((value) => value.replace('2. Second vendor', '1. Second vendor'));
    await f.notion.saveNotes(ai, { page, notes: '1. First vendor\n2. Second vendor' });
    assert.equal(f.content(), '1. First vendor\n1. Second vendor');
    assert.equal(f.writes.length, 1);
  } finally { await f.close(); }
});
test('parser warnings remain a real save failure and cannot authorize a handoff', async () => {
  const f = await fixture(); try {
    f.setStatus('Idea'); f.warnContent();
    await assert.rejects(f.notion.saveNotes(ai, { page, notes: 'A dropped line' }), /content warnings/);
    assert.equal(f.status(), 'Idea');
  } finally { await f.close(); }
});
test('notes edits preserve run history and a fresh handoff excludes previous answers', async () => {
  const f = await fixture(); try {
    await f.notion.claim(ai, page); await f.notion.finish(run);
    const history = f.content().slice(f.content().indexOf('## Open Carter run run1'));
    assert.equal((await f.notion.readNotes(ai, page)).notes, 'Research this topic. Preserve these instructions.');
    await f.notion.saveNotes(ai, { page, notes: 'Compare the law practice vendors only.' });
    assert.ok(f.content().endsWith(history));
    assert.equal(await f.notion.readTask(ai, page), '# Research\n\nCompare the law practice vendors only.');
    const before = f.writes.length;
    await f.notion.saveNotes(ai, { page, notes: 'Compare the law practice vendors only.' });
    assert.equal(f.writes.length, before);
  } finally { await f.close(); }
});
test('a run-heading example in fenced notes is not mistaken for saved history', async () => {
  const f = await fixture(); try {
    const notes = 'Example:\n```markdown\n## Open Carter run example\n```\nThe actual requirement.';
    f.setContent(notes);
    assert.equal((await f.notion.readNotes(ai, page)).notes, notes);
    assert.equal(await f.notion.readTask(ai, page), `# Research\n\n${notes}`);
  } finally { await f.close(); }
});
test('an empty existing task page accepts a brief without requiring a Notion detour', async () => {
  const f = await fixture(); try {
    f.setStatus('Idea'); f.clear();
    await f.notion.saveNotes(ai, { page, notes: 'Deliver a checked implementation plan.' });
    assert.equal(f.writes[0].command, 'replace_content');
    assert.equal((await f.notion.readNotes(ai, page)).notes, 'Deliver a checked implementation plan.');
    assert.equal(f.status(), 'Idea');
  } finally { await f.close(); }
});
test('inline code keeps literal backslashes and line-break tags when editing or comparing notes', async () => {
  const f = await fixture(); try {
    f.setStatus('Idea'); f.setContent('Use `\\$literal<br>` and ``a`b``.');
    assert.equal((await f.notion.readNotes(ai, page)).notes, 'Use `\\$literal<br>` and ``a`b``.');
    await f.notion.saveNotes(ai, { page, notes: 'Use `$literal<br>` and ``a`b``.' });
    assert.equal(f.writes.filter((write) => write.command === 'update_content').length, 1);
  } finally { await f.close(); }
});
test('an unfinished code block cannot absorb or erase existing run history', async () => {
  const f = await fixture(); try {
    await f.notion.claim(ai, page); await f.notion.finish(run);
    const original = f.content(); const before = f.writes.length;
    await assert.rejects(f.notion.saveNotes(ai, { page, notes: '```python\nprint("unfinished")' }), /Close the code block/);
    assert.equal(f.content(), original); assert.equal(f.writes.length, before);
    assert.equal(await f.notion.readTask(ai, page), '# Research\n\nResearch this topic. Preserve these instructions.');
  } finally { await f.close(); }
});

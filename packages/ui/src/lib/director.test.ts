import { afterEach, expect, test } from 'bun:test';
import { DirectorError, improveWithDirector } from './director';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from './runtime-url';

const originalFetch = globalThis.fetch;
const originalResolver = getRuntimeUrlResolver();

afterEach(() => {
  globalThis.fetch = originalFetch;
  setRuntimeUrlResolver(originalResolver);
});
const ask = () => improveWithDirector({ directory: '/f', folderName: 'F', prompt: 'x' });
const failure = async () => { try { await ask(); } catch (error) { return error; } return null; };

test('a good answer is returned with what it used', async () => {
  globalThis.fetch = async () => Response.json({ text: 'Better.', used: { rules: true, memoryFile: true, entries: 2 }, model: 'm' });
  expect((await ask()).text).toBe('Better.');
});

test('a ZDR refusal is told apart from an outage', async () => {
  globalThis.fetch = async () => Response.json({ error: 'off', reason: 'zdr' }, { status: 403 });
  const blocked = await failure();
  expect(blocked instanceof DirectorError && blocked.reason).toBe('zdr');
  globalThis.fetch = async () => Response.json({ error: 'down' }, { status: 502 });
  const unavailable = await failure();
  expect(unavailable instanceof DirectorError && unavailable.reason).toBe('unavailable');
  globalThis.fetch = async () => Response.json({ nope: true });
  expect(await failure()).toBeInstanceOf(DirectorError);
});

test('passes the composer model and folder through the active runtime', async () => {
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
  let sentBody = '';
  let sentUrl = '';
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    sentUrl = request.url;
    sentBody = await request.text();
    return Response.json({ text: 'Better.', used: { rules: false, memoryFile: false, entries: 0 }, model: 'custom-model' });
  };
  await improveWithDirector({
    directory: '/folders/two with spaces', folderName: 'Second', prompt: 'draft',
    preferredProviderID: 'custom-provider', preferredModelID: 'custom-model',
  });
  expect(sentUrl).toBe('https://runtime.example/api/openchamber/director/improve');
  expect(JSON.parse(sentBody)).toEqual({
    directory: '/folders/two with spaces', folderName: 'Second', prompt: 'draft',
    preferredProviderID: 'custom-provider', preferredModelID: 'custom-model',
  });
});

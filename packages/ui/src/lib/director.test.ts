import { afterEach, expect, mock, test } from 'bun:test';

let respond: () => Promise<Response> = async () => new Response('{}');
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: () => respond() }));
const { DirectorError, improveWithDirector } = await import('./director');

afterEach(() => { respond = async () => new Response('{}'); });
const ask = () => improveWithDirector({ directory: '/f', folderName: 'F', prompt: 'x' });
const failure = async () => { try { await ask(); } catch (error) { return error; } return null; };

test('a good answer is returned with what it used', async () => {
  respond = async () => Response.json({ text: 'Better.', used: { rules: true, memoryFile: true, entries: 2 }, model: 'm' });
  expect((await ask()).text).toBe('Better.');
});

test('a ZDR refusal is told apart from an outage', async () => {
  respond = async () => Response.json({ error: 'off', reason: 'zdr' }, { status: 403 });
  expect((await failure() as InstanceType<typeof DirectorError>).reason).toBe('zdr');
  respond = async () => Response.json({ error: 'down' }, { status: 502 });
  expect((await failure() as InstanceType<typeof DirectorError>).reason).toBe('unavailable');
  respond = async () => Response.json({ nope: true });
  expect(await failure()).toBeInstanceOf(DirectorError);
});

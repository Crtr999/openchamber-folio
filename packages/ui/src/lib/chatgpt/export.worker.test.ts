import { expect, test } from 'bun:test';
import { zipSync, strToU8 } from 'fflate';

const example = [{ id: 'demo', title: 'Example', current_node: 'a', mapping: { a: { parent: null, message: { author: { role: 'user' }, content: { parts: ['Hello'] } } } } }];
async function read(bytes: Uint8Array, zip: boolean) {
  const worker = new Worker(new URL('./export.worker.ts', import.meta.url).href);
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Worker timed out')), 5000);
      worker.onmessage = event => { clearTimeout(timeout); resolve(event.data); };
      worker.onerror = event => { clearTimeout(timeout); reject(new Error(event.message)); };
      worker.postMessage({ bytes: bytes.buffer, zip });
    });
  } finally { worker.terminate(); }
}

test('worker reads export JSON and ZIP without importing other archive files', async () => {
  const result = await read(zipSync({ 'conversations.json': strToU8(JSON.stringify(example)), 'private/record.pdf': strToU8('private-record-body') }), true);
  expect(result).toMatchObject({ kind: 'ready', skipped: 0, conversations: [{ sourceId: 'demo', title: 'Example', omittedAttachments: 0 }] });
  expect(JSON.stringify(result)).not.toContain('private-record-body');
  expect(await read(strToU8(JSON.stringify(example)), false)).toMatchObject({ kind: 'ready' });
});

test('worker reports malformed and ambiguous archives without exposing data', async () => {
  expect(await read(strToU8('sensitive invalid JSON'), false)).toEqual({ kind: 'error', code: 'invalid' });
  expect(await read(zipSync({ 'a/conversations.json': strToU8('[]'), 'b/conversations.json': strToU8('[]') }), true)).toEqual({ kind: 'error', code: 'invalid' });
});

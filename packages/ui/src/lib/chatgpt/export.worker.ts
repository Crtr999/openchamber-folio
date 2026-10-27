import { unzipSync, strFromU8 } from 'fflate';
import { z } from 'zod';
import { MAX_EXPORT_BYTES, readChatGPTExport, ChatGPTExportError } from './export';

const requestSchema = z.object({ bytes: z.instanceof(ArrayBuffer), zip: z.boolean() });
self.onmessage = (event: MessageEvent<unknown>) => {
  try {
    const { bytes, zip } = requestSchema.parse(event.data);
    if (bytes.byteLength > MAX_EXPORT_BYTES) throw new ChatGPTExportError('large');
    let content = new Uint8Array(bytes);
    if (zip) {
      const entries = unzipSync(content, { filter: entry => /(^|\/)conversations\.json$/.test(entry.name) && entry.originalSize <= MAX_EXPORT_BYTES });
      const files = Object.values(entries);
      if (files.length !== 1) throw new ChatGPTExportError('invalid');
      content = files[0];
    }
    if (content.byteLength > MAX_EXPORT_BYTES) throw new ChatGPTExportError('large');
    self.postMessage({ kind: 'ready', ...readChatGPTExport(strFromU8(content)) });
  } catch (error) {
    self.postMessage({ kind: 'error', code: error instanceof ChatGPTExportError ? error.code : 'invalid' });
  }
};

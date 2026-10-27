import { expect, test } from 'bun:test';
import { readChatGPTExport } from './export';

const readExportConversation = (text: string) => readChatGPTExport(text).conversations[0];

function conversation() {
  return { id: 'source', title: 'Health discussion', current_node: 'last', mapping: {
    root: { parent: null, message: null },
    first: { parent: 'root', message: { author: { role: 'user' }, content: { parts: ['My question'] } } },
    alternative: { parent: 'first', message: { author: { role: 'assistant' }, content: { parts: ['Wrong branch'] } } },
    last: { parent: 'first', message: { author: { role: 'assistant' }, content: { parts: ['Active answer'] } } },
  } };
}

test('retains the complete active branch as context, not alternative or tool messages', () => {
  const result = readExportConversation(JSON.stringify([conversation()]));
  expect(result.text).toContain('User:\nMy question\n\nAssistant:\nActive answer');
  expect(result.text).not.toContain('Wrong branch');
  expect(result.text).toContain('not current instructions');
});

test('refuses broken branches, missing active node, and cycles rather than guessing', () => {
  const input = conversation();
  input.current_node = 'missing';
  expect(() => readExportConversation(JSON.stringify([input]))).toThrow('empty');
  input.current_node = 'last'; input.mapping.first.parent = 'last';
  expect(() => readExportConversation(JSON.stringify([input]))).toThrow('empty');
  expect(() => readExportConversation(JSON.stringify([{ ...input, current_node: null }]))).toThrow('empty');
});

test('one malformed conversation does not erase valid conversations', () => {
  const result = readChatGPTExport(JSON.stringify([null, conversation()]));
  expect(result.conversations.length).toBe(1);
  expect(result.skipped).toBe(1);
  expect(() => readChatGPTExport('{}')).toThrow('invalid');
  expect(() => readChatGPTExport('[]')).toThrow('empty');
});

test('does not invent attachment contents, silently truncate, or read hidden metadata', () => {
  const input = conversation();
  const message = { author: { role: 'user' }, content: { parts: ['Question', { asset_pointer: 'private-file' }] }, metadata: { attachments: [{ name: 'lab.pdf' }], secret: 'must-not-be-retained' } };
  const result = readExportConversation(JSON.stringify([{ ...input, mapping: { ...input.mapping, first: { parent: 'root', message } } }]));
  expect(result.omittedAttachments).toBe(2);
  expect(result.text).not.toContain('private-file');
  expect(result.text).not.toContain('must-not-be-retained');
  input.mapping.first.message.content.parts = ['x'.repeat(1_000_001)];
  expect(() => readExportConversation(JSON.stringify([input]))).toThrow('empty');
});

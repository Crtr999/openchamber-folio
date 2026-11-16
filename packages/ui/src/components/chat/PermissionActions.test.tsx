import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import type { PermissionReply, PermissionRequest } from '@/types/permission';
import { PermissionActions } from './PermissionActions';

const permission: PermissionRequest = {
  id: 'permission-test',
  sessionID: 'session-test',
  action: 'shell',
  resources: ['printf hello'],
  save: ['printf *', 'echo *', 'cat *'],
  message: 'Inspect this exact operation',
  metadata: { command: 'printf hello', cwd: '/repo', customContext: 'keep this detail' },
};

describe('shared inline and dock approvals', () => {
  for (const variant of ['inline', 'dock'] as const) {
    test(`${variant} keeps choices locked and announces pending or failed replies`, () => {
      const render = (isResponding: boolean, hasError: boolean) => renderToStaticMarkup(
        <I18nProvider>
          <PermissionActions permission={permission} variant={variant} isResponding={isResponding} hasError={hasError} onRespond={() => {}} />
        </I18nProvider>,
      );
      const pending = render(true, false);
      expect(pending.match(/disabled=""/g)).toHaveLength(3);
      expect(pending).toContain('aria-busy="true"');
      expect(pending).toContain('Sending your decision');
      expect(pending).toContain('role="status"');
      expect(pending).toContain('printf *, echo *, cat *');
      const failed = render(false, true);
      expect(failed).not.toContain('disabled=""');
      expect(failed).toContain('role="alert"');
      expect(failed).toContain('Choose an action to retry');
      expect(failed).toContain('Allow once');
      expect(failed).toContain('Deny');
    });
  }

  test('both presentations send only the clicked choice, and pending buttons cannot submit', async () => {
    const dom = new Window();
    const names = ['window', 'document', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT'];
    const descriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.assign(globalThis, {
      window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const { createRoot } = await import('react-dom/client');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const responses: PermissionReply[] = [];
    try {
      for (const variant of ['inline', 'dock'] as const) {
        const render = async (pending: boolean) => {
          await act(async () => root.render(
            <I18nProvider>
              <PermissionActions permission={permission} variant={variant} isResponding={pending} onRespond={(response) => responses.push(response)} />
            </I18nProvider>,
          ));
        };
        await render(false);
        for (const button of host.querySelectorAll<HTMLButtonElement>('button')) {
          await act(async () => button.click());
        }
        expect(responses.splice(0)).toEqual(['reject', 'always', 'once']);
        await render(true);
        for (const button of host.querySelectorAll<HTMLButtonElement>('button')) {
          await act(async () => button.click());
        }
        expect(responses).toEqual([]);
      }
    } finally {
      await act(async () => root.unmount());
      dom.happyDOM.close();
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
});

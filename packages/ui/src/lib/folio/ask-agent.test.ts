import { describe, expect, test } from 'bun:test';

import { FOLIO_ASK_AGENT, FOLIO_ASK_PERMISSIONS } from './ask-agent';

/**
 * OpenCode evaluates a ruleset by taking the last rule whose action and resource
 * both match the request, so these two assertions are the whole contract: the
 * order has to stay catch-all-first, and the only capabilities named after it
 * are the ones Ask AI promises the model.
 */
const effectFor = (action: string): string => {
  const rules = FOLIO_ASK_PERMISSIONS.filter((rule) => rule.action === action || rule.action === '*');
  return rules.at(-1)?.effect ?? 'ask';
};

describe('the ruleset a page conversation runs under', () => {
  test('denies every built-in tool that could leave the page', () => {
    // The transcript that started this: a worker reading its memory file and
    // running `shell` to find the source instead of answering from the page.
    for (const action of ['bash', 'read', 'write', 'edit', 'patch', 'glob', 'grep', 'list', 'task']) {
      expect(effectFor(action)).toBe('deny');
    }
  });

  test('leaves the notebook tools and nothing else open', () => {
    expect(FOLIO_ASK_PERMISSIONS.filter((rule) => rule.effect === 'allow').map((rule) => rule.action))
      .toEqual(['folio', 'openchamber']);
  });

  test('closes everything first, because a later match wins', () => {
    expect(FOLIO_ASK_PERMISSIONS[0]).toEqual({ action: '*', resource: '*', effect: 'deny' });
  });

  test('has no other way out: nothing asks, so nothing raises a permission card', () => {
    expect(FOLIO_ASK_PERMISSIONS.some((rule) => rule.effect === 'ask')).toBe(false);
  });
});

describe('the agent a page conversation runs on', () => {
  test('is Folio\'s own agent, not one the chat beside it is on', () => {
    // The id OpenChamber publishes into the managed config wherever the
    // notebook is hosted. It is a constant on purpose: reading the ordinary
    // chat's agent here is the bug this replaced.
    expect(FOLIO_ASK_AGENT).toBe('folio-ask');
  });
});

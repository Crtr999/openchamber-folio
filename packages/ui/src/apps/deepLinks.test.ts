import { describe, expect, test } from 'bun:test';
import { parseDeepLink } from './deepLinks';

describe('native companion links', () => {
  test('opens recording controls with no text, send or capture parameters', () => {
    expect(parseDeepLink('openchamber://dictate')).toEqual({ type: 'dictation' });
    expect(parseDeepLink('opencarter://dictate')).toEqual({ type: 'dictation' });
    expect(parseDeepLink('openchamber://dictate?send=true&record=true&text=untrusted')).toEqual({ type: 'dictation' });
    expect(parseDeepLink('https://untrusted.test/dictate')).toBeNull();
    expect(parseDeepLink('openchamber://unrecognised')).toBeNull();
  });
  test('retains notification and new-chat navigation', () => {
    expect(parseDeepLink('openchamber://session/session-1?dir=%2Fworkspace')).toEqual({ type: 'session', sessionId: 'session-1', directory: '/workspace' });
    expect(parseDeepLink('openchamber://new?project=project-1')?.type).toBe('new-session');
  });
});

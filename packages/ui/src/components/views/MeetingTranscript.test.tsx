import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MeetingTranscript } from './MeetingTranscript';

const labels = { microphone: 'Microphone', system: 'System audio', listening: 'Recording' };
const segment = (source: 'microphone' | 'system', startMs: number, text: string, createdAt: string) => ({ source, label: source === 'microphone' ? 'Microphone' as const : 'System audio' as const, startMs, endMs: startMs + 1000, text, createdAt });
const old = '2020-01-01T00:00:00.000Z';

describe('MeetingTranscript', () => {
  test('a finished transcript is complete, ordered by time across sources, and has no listening row', () => {
    const markup = renderToStaticMarkup(<MeetingTranscript live={false} labels={labels} segments={[segment('system', 5000, 'second', old), segment('microphone', 1000, 'first', old)]} />);
    expect(markup.indexOf('first')).toBeLessThan(markup.indexOf('second'));
    expect(markup).not.toContain('Recording…');
    expect(markup).toContain('0:01 · Microphone');
  });

  test('while live, history is shown at once, a just-arrived phrase starts empty so it can type in, and a listening row shows', () => {
    const fresh = new Date().toISOString();
    const markup = renderToStaticMarkup(<MeetingTranscript live labels={labels} segments={[segment('microphone', 0, 'earlier words', old), segment('microphone', 4000, 'brand new phrase', fresh)]} />);
    expect(markup).toContain('earlier words');
    expect(markup).not.toContain('brand new phrase');
    expect(markup).toContain('0:04 · Microphone');
    expect(markup).toContain('Recording…');
    expect(markup).toContain('aria-live="polite"');
  });
});

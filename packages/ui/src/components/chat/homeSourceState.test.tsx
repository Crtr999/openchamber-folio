import React from 'react';
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { HomeSources } from './HomeSources';
import { homeSourceStates, type HomeSourceEvidence } from './homeSourceState';
import { homeSourcesI18n } from '@/lib/i18n/messages/home-sources.i18n';
import { createHomeSourceReads } from './useHomeSourceReads';

const evidence: HomeSourceEvidence = {
    supported: true, blocked: false, networkBlocked: false,
    notion: null, calendar: null, notionFailed: false, calendarFailed: false,
};
const notion = { connected: true, signingIn: false, board: 'private-board', habits: 'private-habits', destination: 'private-page' };
const calendar = { access: 'connected', calendars: [], events: [] } as const;

test('missing observations never imply connection or freshness', () => {
    expect(homeSourceStates(evidence)).toEqual({ notion: 'unknown', calendar: 'unknown' });
    expect(homeSourceStates({ ...evidence, notion })).toEqual({ notion: 'savedConnection', calendar: 'unknown' });
    expect(homeSourceStates({ ...evidence, notion: { ...notion, connected: false, signingIn: true } }).notion).toBe('signingIn');
    expect(homeSourceStates({ ...evidence, notion: { ...notion, connected: false } }).notion).toBe('disconnected');
});

test('failure takes precedence over previous success without erasing unrelated source evidence', () => {
    const connected = { ...evidence, notion, calendar: { ...calendar, calendars: [], events: [] } };
    expect(homeSourceStates({ ...connected, notionFailed: true })).toEqual({ notion: 'failed', calendar: 'permissionGranted' });
    expect(homeSourceStates({ ...connected, calendarFailed: true }).calendar).toBe('failed');
    expect(homeSourceStates({ ...connected, calendar: { ...connected.calendar, error: 'private error' } }).calendar).toBe('failed');
    expect(homeSourceStates({ ...evidence, calendar: { access: 'not-connected', calendars: [], events: [] } }).calendar).toBe('permissionRequired');
    expect(homeSourceStates({ ...evidence, calendar: { access: 'unsupported', calendars: [], events: [] } }).calendar).toBe('unsupported');
});

test('unsupported runtimes hide native evidence; policy blocks Notion but not local Calendar', () => {
    expect(homeSourceStates({ ...evidence, notion, supported: false })).toEqual({ notion: 'unsupported', calendar: 'unsupported' });
    expect(homeSourceStates({ ...evidence, notion, blocked: true })).toEqual({ notion: 'blocked', calendar: 'unknown' });
    expect(homeSourceStates({ ...evidence, notion, networkBlocked: true }).notion).toBe('blocked');
    for (const policy of [{ blocked: true }, { networkBlocked: true }, { blocked: true, networkBlocked: true }]) {
        const connected = { ...evidence, ...policy, notion, calendar: { ...calendar, calendars: [], events: [] } };
        expect(homeSourceStates(connected)).toEqual({ notion: 'blocked', calendar: 'permissionGranted' });
        expect(homeSourceStates({ ...connected, calendarFailed: true }).calendar).toBe('failed');
        expect(homeSourceStates({ ...connected, calendar: { ...connected.calendar, error: 'Calendar read failed' } }).calendar).toBe('failed');
        expect(homeSourceStates({ ...connected, calendar: { access: 'not-connected', calendars: [], events: [] } }).calendar).toBe('permissionRequired');
    }
});

test('enterprise and network policy leave Calendar read times visible while hiding Notion evidence', () => {
    const tracker = createHomeSourceReads('local', () => 'local', () => Date.parse('2026-11-16T15:04:05Z'));
    tracker.begin('board').success(); tracker.begin('habits').success(); tracker.begin('calendar').success();
    const projected = { ...evidence, blocked: true, networkBlocked: true, notion, calendar: { ...calendar, calendars: [], events: [] } };
    const markup = () => renderToStaticMarkup(<I18nProvider><HomeSources {...projected} reads={tracker.getSnapshot()} /></I18nProvider>);
    expect(markup()).toContain('Calendar access granted');
    expect(markup().match(/<time /g)).toHaveLength(1);
    tracker.begin('calendar').failure();
    expect(markup()).toContain('Earlier results may be stale');
    expect(markup()).toContain('dateTime="2026-11-16T15:04:05.000Z"');
    tracker.reset('calendar');
    expect(markup()).not.toContain('<time');
    expect(markup()).toContain('No successful Home read yet');
});

test('read-only rendering exposes only metadata, no personal values or mutation controls', () => {
    const reads = createHomeSourceReads('local', () => 'local').getSnapshot();
    const markup = renderToStaticMarkup(<I18nProvider><HomeSources {...evidence} notion={notion} reads={reads} /></I18nProvider>);
    expect(markup).toContain('Live access not verified');
    expect(markup).toContain('Native cache age is unknown');
    expect(markup).not.toContain('Background awareness');
    expect(markup).not.toContain('<time');
    expect(markup).not.toContain('private-');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('<a ');
});

test('all shipped locales contain real translations for source state copy', () => {
    const english = new Map(Object.entries(homeSourcesI18n.en));
    for (const [locale, messages] of Object.entries(homeSourcesI18n)) {
        expect(Object.keys(messages).sort()).toEqual(Object.keys(homeSourcesI18n.en).sort());
        for (const [key, value] of Object.entries(messages)) {
            expect(value.length).toBeGreaterThan(0);
            if (locale !== 'en' && key !== 'home.sources.notion') expect(value).not.toBe(english.get(key));
        }
        expect(messages['home.sources.lastRead']).toContain('{time}');
    }
});

test('only successful content completions acquire read times; failures retain the last good time', () => {
    let now = 100;
    const tracker = createHomeSourceReads('local', () => 'local', () => now);
    expect(tracker.getSnapshot()).toEqual({ board: { kind: 'unknown' }, habits: { kind: 'unknown' }, calendar: { kind: 'unknown' } });
    const read = tracker.begin('board');
    expect(tracker.getSnapshot().board).toEqual({ kind: 'unknown' });
    read.success();
    expect(tracker.getSnapshot().board).toEqual({ kind: 'read', readAt: 100 });
    now = 200;
    tracker.begin('board').failure();
    expect(tracker.getSnapshot().board).toEqual({ kind: 'failed', readAt: 100 });
    tracker.begin('habits').failure();
    expect(tracker.getSnapshot().habits).toEqual({ kind: 'failed', readAt: null });
    tracker.begin('board').success();
    expect(tracker.getSnapshot().board).toEqual({ kind: 'read', readAt: 200 });
});

test('source reset clears only its observations and rejects reads started before reconfiguration or disconnection', () => {
    const tracker = createHomeSourceReads('local', () => 'local', () => 100);
    tracker.begin('calendar').success();
    tracker.begin('board').success();
    const oldBoard = tracker.begin('board');
    const oldHabits = tracker.begin('habits');
    tracker.reset('board', 'habits');
    oldBoard.success(); oldHabits.failure();
    expect(tracker.getSnapshot()).toEqual({ board: { kind: 'unknown' }, habits: { kind: 'unknown' }, calendar: { kind: 'read', readAt: 100 } });
    tracker.reset('calendar');
    expect(tracker.getSnapshot().calendar).toEqual({ kind: 'unknown' });
});

test('runtime changes begin unknown and cannot accept late completions from an older runtime', () => {
    let runtime = 'first';
    const first = createHomeSourceReads(runtime, () => runtime, () => 100);
    first.begin('habits').success();
    const oldRead = first.begin('calendar');
    runtime = 'second';
    const second = createHomeSourceReads(runtime, () => runtime, () => 200);
    oldRead.success();
    expect(first.getSnapshot().calendar).toEqual({ kind: 'unknown' });
    expect(second.getSnapshot().habits).toEqual({ kind: 'unknown' });
    second.begin('calendar').success();
    expect(second.getSnapshot().calendar).toEqual({ kind: 'read', readAt: 200 });
    // Hook cleanup invalidates the previous generation even when returning to
    // the same runtime identity later.
    first.reset('board', 'habits', 'calendar');
    runtime = 'first'; oldRead.success();
    expect(first.getSnapshot().calendar).toEqual({ kind: 'unknown' });
});

test('absolute read times carry machine-readable dates and remain visible when stale', () => {
    const at = Date.parse('2026-11-16T15:04:05Z');
    const tracker = createHomeSourceReads('local', () => 'local', () => at);
    tracker.begin('board').success(); tracker.begin('board').failure();
    const markup = renderToStaticMarkup(<I18nProvider><HomeSources {...evidence} notion={notion} reads={tracker.getSnapshot()} /></I18nProvider>);
    expect(markup).toContain(`dateTime="2026-11-16T15:04:05.000Z"`);
    expect(markup).toContain('Last read');
    expect(markup).toContain('Earlier results may be stale');
    expect(markup).toContain('2026');
    expect(markup).toContain('data-read-state="failed"');
});

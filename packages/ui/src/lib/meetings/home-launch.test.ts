import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('Home exposes a compact meeting launch in the greeting row before widgets that never starts capture itself', () => {
  const home = readFileSync(new URL('../../components/chat/HomeDashboard.tsx', import.meta.url), 'utf8');
  expect(home.indexOf("t('meeting.quickStart')")).toBeLessThan(home.indexOf('<HomePersonalPanels>'));
  const input = readFileSync(new URL('../../components/chat/ChatInput.tsx', import.meta.url), 'utf8');
  expect(input).toContain('<HomeQuickActions stacked');
  expect(home).toContain('meetingsSupported()');
  expect(home).toContain('openMeetingWorkspace({ title:');
  expect(home).not.toContain('meetingCapture.start');
  const launch = home.slice(home.indexOf('export const HomeQuickActions'), home.indexOf('export const HomeDashboard'));
  expect(launch).toContain('if (!meetingsSupported()) return null');
  expect(launch).toContain('autoStart: true');
});

test('launch resets the selected view, not saved meetings, and only auto-starts after remembered consent and readiness', () => {
  const workspace = readFileSync(new URL('../../components/views/MeetingWorkspace.tsx', import.meta.url), 'utf8');
  const launch = workspace.slice(workspace.indexOf('const launch ='), workspace.indexOf('window.addEventListener(MEETING_WORKSPACE_EVENT'));
  expect(launch).toContain('setSelected(null)');
  expect(launch).toContain('setConsentState(storedConsent())');
  expect(launch).not.toContain('createMeeting');
  expect(launch).not.toContain('setMeetings');
  expect(workspace).toContain("const ready = Boolean(readiness?.available)");
  expect(workspace).toContain("!consent || !ready");
  const quick = workspace.slice(workspace.indexOf('const quickStart ='), workspace.indexOf('const notes ='));
  expect(quick).toContain('!storedConsent()');
  expect(quick).toContain('meetingReadiness()');
  expect(quick.indexOf('meetingReadiness()')).toBeLessThan(quick.indexOf('createMeeting('));
  expect(workspace).toContain("setSettingsPage('voice')");
});

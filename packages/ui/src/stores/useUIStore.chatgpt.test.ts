import { beforeEach, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';
import { useConfigStore } from './useConfigStore';

beforeEach(() => useUIStore.getState().closeMainSurfaces());

test('ChatGPT replaces an open page and preserves OpenCode selections', () => {
  const config = useConfigStore.getState();
  const selection = [config.currentProviderId, config.currentModelId, config.currentAgentName];
  useUIStore.getState().setScheduledTasksDialogOpen(true);
  useUIStore.getState().setChatGPTPageOpen(true);
  const ui = useUIStore.getState();
  expect(ui.isChatGPTPageOpen).toBe(true);
  expect(ui.isScheduledTasksDialogOpen).toBe(false);
  expect(ui.isArchivePageOpen).toBe(false);
  expect(ui.isUsageStatsPageOpen).toBe(false);
  expect(ui.worktreesPageProjectId).toBeNull();
  expect(ui.openGuestPageId).toBeNull();
  expect(ui.runOverviewKey).toBeNull();
  const after = useConfigStore.getState();
  expect([after.currentProviderId, after.currentModelId, after.currentAgentName]).toEqual(selection);
});

test('Home closes the ChatGPT workspace', () => {
  useUIStore.getState().setChatGPTPageOpen(true);
  useUIStore.getState().closeMainSurfaces();
  expect(useUIStore.getState().isChatGPTPageOpen).toBe(false);
});

test('other main pages replace ChatGPT', () => {
  const ui = useUIStore.getState();
  const transitions = [
    () => ui.setScheduledTasksDialogOpen(true),
    () => ui.setArchivePageOpen(true),
    () => ui.setUsageStatsPageOpen(true),
    () => ui.setWorktreesPageProjectId('project'),
    () => ui.setOpenGuestPage('guest'),
    () => ui.setRunOverviewKey('run'),
  ];
  for (const navigate of transitions) {
    ui.setChatGPTPageOpen(true);
    navigate();
    expect(useUIStore.getState().isChatGPTPageOpen).toBe(false);
  }
});

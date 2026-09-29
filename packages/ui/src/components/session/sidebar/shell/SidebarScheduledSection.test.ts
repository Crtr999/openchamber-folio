import { describe, expect, test } from 'bun:test';
import { formatCompactUntil, sortSidebarScheduledTasks } from './sidebarScheduled';
import type { ScheduledTask } from '@/lib/scheduledTasksApi';
import type { ProjectEntry } from '@/lib/api/types';

const project = { id: 'p1', path: '/work/openrouter' } as ProjectEntry;
const task = (name: string, enabled: boolean, nextRunAt?: number): ScheduledTask => ({
  id: name,
  name,
  enabled,
  schedule: { kind: 'cron', cron: '0 7,9 * * *', timezone: 'America/New_York' },
  execution: { prompt: 'x', providerID: 'openrouter', modelID: 'm' },
  state: { createdAt: 0, updatedAt: 0, nextRunAt },
});

describe('sidebar scheduled section', () => {
  test('compact time until the next run', () => {
    const now = 1_000_000_000_000;
    expect(formatCompactUntil(undefined, now)).toBe('');
    expect(formatCompactUntil(now + 10_000, now)).toBe('now');
    expect(formatCompactUntil(now + 14 * 60_000, now)).toBe('14m');
    expect(formatCompactUntil(now + 3 * 3_600_000, now)).toBe('3h');
    expect(formatCompactUntil(now + 50 * 3_600_000, now)).toBe('2d');
  });

  test('enabled tasks first, soonest next run first, paused last', () => {
    const sorted = sortSidebarScheduledTasks([
      { task: task('Paused', false, 1), project },
      { task: task('Later', true, 500), project },
      { task: task('MacroTrack daily iPhone rebuild', true, 100), project },
      { task: task('No next run', true), project },
    ]);
    expect(sorted.map((item) => item.task.name)).toEqual(['MacroTrack daily iPhone rebuild', 'Later', 'No next run', 'Paused']);
  });
});

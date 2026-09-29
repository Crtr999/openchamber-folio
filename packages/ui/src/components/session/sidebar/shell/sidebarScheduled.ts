import type { ScheduledTask } from '@/lib/scheduledTasksApi';
import type { ProjectEntry } from '@/lib/api/types';

export type SidebarScheduledTask = { task: ScheduledTask; project: ProjectEntry };

/** Time until the next run: "14m", "3h", "2d" — the same compact shape the session rows use for their times. */
export const formatCompactUntil = (target: number | undefined, now: number): string => {
  if (!target || !Number.isFinite(target)) return '';
  const minutes = Math.max(0, Math.round((target - now) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
};

/** Enabled tasks first, then soonest next run, then name. */
export const sortSidebarScheduledTasks = (items: SidebarScheduledTask[]): SidebarScheduledTask[] => [...items].sort((a, b) => {
  if (a.task.enabled !== b.task.enabled) return a.task.enabled ? -1 : 1;
  const byNext = (a.task.state?.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.task.state?.nextRunAt ?? Number.MAX_SAFE_INTEGER);
  if (byNext !== 0) return byNext;
  return a.task.name.localeCompare(b.task.name);
});

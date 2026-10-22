import { describe, expect, test } from 'bun:test';
import { dueLabel } from './commitments';

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

describe('dueLabel', () => {
  const now = at(2026, 10, 22, 15);
  test('counts calendar days, not 24-hour spans', () => {
    expect(dueLabel(at(2026, 10, 22, 23), now)).toEqual({ key: 'commitments.due.today' });
    expect(dueLabel(at(2026, 10, 23, 1), now)).toEqual({ key: 'commitments.due.tomorrow' });
    expect(dueLabel(at(2026, 10, 27), now)).toEqual({ key: 'commitments.due.inDays', count: 5 });
  });
  test('reports overdue days and missing dates', () => {
    expect(dueLabel(at(2026, 10, 21, 23), now)).toEqual({ key: 'commitments.due.overdueDay' });
    expect(dueLabel(at(2026, 10, 19), now)).toEqual({ key: 'commitments.due.overdueDays', count: 3 });
    expect(dueLabel(null, now)).toEqual({ key: 'commitments.due.noDate' });
  });
});

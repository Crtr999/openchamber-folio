import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addHabit, dayKey, habitsToday, newHabitsPage, toggleHabit } from './habits';

test('habits tick off per day and count streaks', () => {
  const day = 86_400_000, now = new Date(2026, 8, 26, 12).getTime();
  let page = newHabitsPage('0F2C7A52-6F7C-4D57-9A8E-2B1F1F5A1C11', now, ['Read']);
  page = toggleHabit(page, 'h0', now - 2 * day);
  page = toggleHabit(page, 'h0', now - day);
  assert.deepEqual(habitsToday(page, now).map((h) => [h.name, h.done, h.streak]), [['Read', false, 2]]);
  page = toggleHabit(page, 'h0', now);
  assert.equal(habitsToday(page, now)[0].streak, 3);
  page = toggleHabit(page, 'h0', now);
  assert.equal(habitsToday(page, now)[0].done, false);
  page = addHabit(page, 'Workout');
  assert.deepEqual(habitsToday(page, now).map((h) => h.name), ['Read', 'Workout']);
  assert.equal(dayKey(now), '2026-09-26');
});

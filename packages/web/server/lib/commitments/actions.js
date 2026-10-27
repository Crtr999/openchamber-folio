/**
 * What an agent in any chat can do with the commitments list when the user
 * asks it to: see it, add to it, change a date, mark something done, snooze,
 * or drop it. This is the only management surface: there is no settings screen
 * and no list page, the user just talks to the folder they are already in.
 *
 * Refused from a folder the guard does not allow (ZDR), so a zero-retention
 * conversation can neither read nor change the list.
 */
import { DateTime } from 'luxon';
import { OpenChamberControlError } from '../openchamber-control/error.js';

const DAY_MS = 86_400_000;

const view = (item, timezone) => ({
  id: item.id,
  title: item.title,
  due: item.dueAt == null ? null : DateTime.fromMillis(item.dueAt, { zone: timezone }).toFormat('yyyy-LL-dd'),
  status: item.status,
  watching: item.watches,
  notes: item.notes || null,
  lastUpdate: item.finding || null,
  webResearch: item.research,
  addedAutomatically: item.origin === 'auto' && !item.confirmedAt,
});

const parseDay = (value, timezone) => {
  const parsed = DateTime.fromISO(String(value ?? '').trim(), { zone: timezone });
  if (!parsed.isValid) throw new OpenChamberControlError('Give dates as YYYY-MM-DD', 400);
  return parsed.set({ hour: 23, minute: 59, second: 0, millisecond: 0 }).toMillis();
};

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

export const createCommitmentActions = ({ store, guard, onChanged = () => {}, getReviewModel = async () => null, now = () => Date.now() }) => {
  const resolve = (items, reference) => {
    const wanted = text(reference);
    if (!wanted) throw new OpenChamberControlError('commitmentId is required (an id from commitment.list, or words from its title)', 400);
    const open = items.filter((item) => item.status !== 'dismissed');
    const exact = open.find((item) => item.id === wanted);
    if (exact) return exact;
    const needle = wanted.toLowerCase();
    const matches = open.filter((item) => item.title.toLowerCase().includes(needle));
    if (matches.length === 1) return matches[0];
    throw new OpenChamberControlError(
      matches.length ? `More than one commitment matches "${wanted}"; use an id from commitment.list` : `No commitment matches "${wanted}"`,
      matches.length ? 409 : 404,
    );
  };

  const execute = async (action, input = {}, contextDirectory, options = {}) => {
    const verdict = await guard.check(contextDirectory);
    if (!verdict.ok) throw new OpenChamberControlError('Commitments are not available in this folder', 403);
    const state = await store.read();
    const { timezone } = state.settings;
    const reviewModel = options.contextSessionId ? await getReviewModel(options.contextSessionId) : null;

    if (action === 'commitment.list') {
      const items = state.items.filter((item) => item.status === 'active' || item.status === 'snoozed')
        .sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
      return { commitments: items.map((item) => view(item, timezone)) };
    }

    if (action === 'commitment.add') {
      const title = text(input.title);
      const watch = text(input.watch);
      if (!title) throw new OpenChamberControlError('title is required', 400);
      if (!text(input.due) && !watch) throw new OpenChamberControlError('Give a due date (YYYY-MM-DD) or something to watch', 400);
      const same = reviewModel && state.items.find((item) => item.status === 'active' && item.title.toLowerCase() === title.slice(0, 160).toLowerCase());
      if (same) {
        const changes = { research: false, reviewModel };
        if (text(input.due)) changes.dueAt = parseDay(input.due, timezone);
        if (text(input.notes)) changes.notes = text(input.notes).slice(0, 400);
        return { commitment: view(await store.patch(same.id, changes), timezone), updated: true };
      }
      const addition = {
        reviewModel: reviewModel || undefined,
      };
      const item = await store.add({
        ...addition,
        title: title.slice(0, 160),
        dueAt: text(input.due) ? parseDay(input.due, timezone) : null,
        watches: watch ? [watch.slice(0, 200)] : [],
        notes: (text(input.notes) ?? '').slice(0, 400),
        research: reviewModel ? false : input.research !== false,
        origin: 'manual',
        confirmedAt: now(),
        sourceDirectory: text(contextDirectory) ?? undefined,
        sourceSessionId: text(options.contextSessionId) ?? undefined,
      });
      onChanged();
      return { commitment: view(item, timezone) };
    }

    const target = resolve(state.items, input.commitmentId);
    if (action === 'commitment.remove') {
      await store.patch(target.id, { status: 'dismissed' });
      onChanged();
      return { removed: true, id: target.id };
    }
    if (action === 'commitment.update') {
      const changes = { confirmed: true };
      if (reviewModel) { changes.reviewModel = reviewModel; changes.research = false; }
      if (text(input.title)) changes.title = text(input.title).slice(0, 160);
      if (text(input.due)) changes.dueAt = parseDay(input.due, timezone);
      if (text(input.watch)) changes.watches = [text(input.watch).slice(0, 200)];
      if (!reviewModel && typeof input.research === 'boolean') changes.research = input.research;
      if (text(input.notes)) changes.notes = text(input.notes).slice(0, 400);
      if (input.status !== undefined) {
        if (!['active', 'done', 'snoozed'].includes(input.status)) throw new OpenChamberControlError('status must be active, done or snoozed', 400);
        changes.status = input.status;
        if (input.status === 'snoozed') {
          changes.snoozedUntil = text(input.until) ? parseDay(input.until, timezone) : now() + DAY_MS;
        }
      }
      const item = await store.patch(target.id, changes);
      onChanged();
      return { commitment: view(item, timezone) };
    }
    throw new OpenChamberControlError(`Unsupported commitment action: ${action}`, 400);
  };

  return { execute };
};

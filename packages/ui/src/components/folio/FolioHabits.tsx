import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useFolioStore } from '@/lib/folio/store';
import { addHabit, findHabitsPage, habitsToday, newHabitsPage, toggleHabit } from '@/lib/folio/habits';

const starterHabits = ['Read 30 min', 'Study', 'Workout', 'Sleep 7h+'];

/** Today's habits as tap-to-check chips with streaks; the same widget on the Mac and the iPhone home. */
export function FolioHabits({ compact }: { compact?: boolean }) {
  const { t } = useI18n();
  const notes = useFolioStore((s) => s.status?.notes);
  const drafts = useFolioStore((s) => s.drafts);
  const [adding, setAdding] = React.useState(false);
  const [name, setName] = React.useState('');
  const stored = findHabitsPage(notes ?? []);
  const page = stored ? drafts[stored.id]?.note ?? stored : undefined;
  const now = Date.now();

  if (!page) {
    return <button type="button" className={cn('flex w-full items-center gap-3 rounded-xl border border-dashed border-border px-3 text-left text-muted-foreground', compact ? 'py-3 text-[15px]' : 'py-2.5 text-sm')}
      onClick={() => {
        // A normal Folio page, so it syncs; it is created without opening it.
        void useFolioStore.getState().run({ command: 'create', kind: 'table', text: 'Habits' }).then((response) => {
          const created = response?.state?.notes.find((n) => n.id === response.state?.selectedID);
          if (created) useFolioStore.getState().edit({ ...newHabitsPage(created.id, now, starterHabits), created: created.created, parentID: created.parentID });
        });
      }}>
      <Icon name="checkbox-circle" className="size-5 shrink-0" />{t('folio.habitsStart')}
    </button>;
  }

  const habits = habitsToday(page, now);
  const doneCount = habits.filter((h) => h.done).length;
  return <div>
    <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
      <span>{t('folio.habitsProgress', { done: doneCount, total: habits.length })}</span>
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${habits.length ? (doneCount / habits.length) * 100 : 0}%` }} /></div>
    </div>
    <div className="flex flex-wrap gap-2">
      {habits.map((habit) => <button key={habit.id} type="button" aria-pressed={habit.done}
        className={cn('flex items-center gap-1.5 rounded-full border px-3 transition-colors', compact ? 'h-10 text-[15px]' : 'h-8 text-sm', habit.done ? 'border-transparent bg-primary text-primary-foreground' : 'border-border bg-background text-foreground hover:bg-interactive-hover')}
        onClick={() => useFolioStore.getState().edit(toggleHabit(page, habit.id, Date.now()))}>
        {habit.done ? <Icon name="check" className="size-4" /> : null}{habit.name}
        {habit.streak > 1 && <span className={cn('text-xs tabular-nums', habit.done ? 'opacity-80' : 'text-muted-foreground')}>🔥{habit.streak}</span>}
      </button>)}
      {adding
        ? <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); useFolioStore.getState().edit(addHabit(page, name)); setName(''); setAdding(false); }}>
          <input autoFocus className={cn('w-36 rounded-full border border-border bg-background px-3 outline-none', compact ? 'h-10 text-[16px]' : 'h-8 text-sm')} placeholder={t('folio.habitsName')} aria-label={t('folio.habitsName')} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { if (!name.trim()) setAdding(false); }} />
        </form>
        : <button type="button" className={cn('flex items-center justify-center rounded-full border border-dashed border-border text-muted-foreground', compact ? 'size-10' : 'size-8')} aria-label={t('folio.habitsAdd')} onClick={() => setAdding(true)}><Icon name="add" className="size-4" /></button>}
    </div>
  </div>;
}

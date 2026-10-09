import React from 'react';
import { DndContext, MouseSensor, TouchSensor, pointerWithin, rectIntersection, useDraggable, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { HomeNotionBoard } from '@/lib/personal-home';
import { cn } from '@/lib/utils';

type Task = HomeNotionBoard['rows'][number];
type BoardProps = {
    board: HomeNotionBoard;
    disabled: boolean;
    pendingPage: string;
    onMove: (page: string, status: string) => void;
    renderTask: (row: Task) => React.ReactNode;
};

const columnId = (column: string) => `home-status:${column}`;
const collisionDetection: CollisionDetection = (args) => {
    const underPointer = pointerWithin(args);
    return underPointer.length ? underPointer : rectIntersection(args);
};

// Date-only values are calendar days, not instants. Timed values retain the
// source's exact time and offset rather than silently adopting this device's zone.
function dueDateText(value: string, isDatetime: boolean, locale: string) {
    if (!isDatetime && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const date = new Date(`${value}T00:00:00Z`);
        if (!Number.isNaN(date.getTime())) return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
    }
    return value.replace('T', ' ');
}

const TaskCard: React.FC<{ row: Task } & Omit<BoardProps, 'board'> & { columns: string[] }> = ({ row, columns, disabled, pendingPage, onMove, renderTask }) => {
    const { t, locale } = useI18n();
    const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, isDragging } = useDraggable({ id: row.url, disabled });
    const pending = pendingPage === row.url;
    return <div ref={setNodeRef} data-home-task={row.url} aria-busy={pending} className={cn('oc-home-task relative', isDragging && 'z-20 opacity-70')} style={{ transform: CSS.Translate.toString(transform) }}>
        <div className="flex min-w-0 items-start gap-1">
            <Button ref={setActivatorNodeRef} type="button" variant="ghost" size="icon" className="size-5 shrink-0 touch-none select-none cursor-grab active:cursor-grabbing" disabled={disabled} {...attributes} {...listeners} tabIndex={-1} aria-describedby={undefined} aria-label={t('home.dragTask')} title={t('home.dragTask')}><Icon name="draggable" className="size-3" /></Button>
            <div className="min-w-0 flex-1">{renderTask(row)}</div>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1 pl-6">
            <span className="min-w-0 flex-1 text-[10px] text-muted-foreground" title={row.due ? [row.due.start, row.due.end].filter(Boolean).join(' / ') : t('home.noDueDate')}>
                {row.due ? <><time dateTime={row.due.start}>{dueDateText(row.due.start, row.due.isDatetime, locale)}</time>{row.due.end && <> / <time dateTime={row.due.end}>{dueDateText(row.due.end, row.due.isDatetime, locale)}</time></>}</> : t('home.noDueDate')}
            </span>
            {pending && <Icon name="loader-4" className="size-3 animate-spin text-muted-foreground" />}
            <DropdownMenu><DropdownMenuTrigger asChild><Button data-home-task-move type="button" variant="ghost" size="icon" className="size-5 shrink-0" disabled={disabled} aria-label={t('home.moveTask')} title={t('home.moveTask')}><Icon name="arrow-left-right" className="size-3" /></Button></DropdownMenuTrigger>
                <DropdownMenuContent>{columns.map((column) => <DropdownMenuItem key={column} nativeButton render={<button type="button" />} disabled={column === row.status} onSelect={() => onMove(row.url, column)}>{column}</DropdownMenuItem>)}</DropdownMenuContent>
            </DropdownMenu>
        </div>
    </div>;
};

const StatusColumn: React.FC<{ column: string; count: number; disabled: boolean; children: React.ReactNode }> = ({ column, count, disabled, children }) => {
    const { setNodeRef, isOver } = useDroppable({ id: columnId(column), disabled });
    return <div ref={setNodeRef} data-home-status={column} className={cn('oc-home-column min-h-16 rounded-sm', isOver && 'ring-2 ring-ring bg-interactive-selection/30')}>
        <h3 className="oc-home-board-heading">{column}<span className="oc-home-count ml-auto">{count}</span></h3>
        {children}
    </div>;
};

export const HomeTaskBoard: React.FC<BoardProps> = ({ board, disabled, pendingPage, onMove, renderTask }) => {
    const boardRef = React.useRef<HTMLDivElement>(null);
    const previousPending = React.useRef('');
    React.useEffect(() => {
        const completed = previousPending.current;
        previousPending.current = pendingPage;
        if (!completed || pendingPage || document.activeElement !== document.body) return;
        const card = [...(boardRef.current?.querySelectorAll<HTMLElement>('[data-home-task]') ?? [])].find((item) => item.dataset.homeTask === completed);
        card?.querySelector<HTMLButtonElement>('[data-home-task-move]')?.focus();
    }, [pendingPage]);
    const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 8 } }), useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }));
    const move = ({ active, over }: DragEndEvent) => {
        if (disabled || !over) return;
        const row = board.rows.find((item) => item.url === active.id);
        const column = board.columns.find((item) => columnId(item) === over.id);
        if (row && column && row.status !== column) onMove(row.url, column);
    };
    const card = (row: Task) => <TaskCard key={row.url} row={row} columns={board.columns} disabled={disabled} pendingPage={pendingPage} onMove={onMove} renderTask={renderTask} />;
    const unassigned = board.rows.filter((row) => !board.columns.includes(row.status ?? ''));
    return <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragEnd={move}>
        <div ref={boardRef} className="oc-home-board">{board.columns.map((column) => {
            const rows = board.rows.filter((row) => row.status === column);
            return <StatusColumn key={column} column={column} count={rows.length} disabled={disabled}>{rows.map(card)}</StatusColumn>;
        })}{unassigned.length > 0 && <div className="oc-home-column">{unassigned.map(card)}</div>}</div>
    </DndContext>;
};

import React from 'react';
import { z } from 'zod';
import { DndContext, MouseSensor, TouchSensor, pointerWithin, rectIntersection, useDraggable, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { HomeNotionBoard } from '@/lib/personal-home';
import { cn } from '@/lib/utils';

type Task = HomeNotionBoard['rows'][number];
type ListProps = {
    board: HomeNotionBoard;
    disabled: boolean;
    onMove: (page: string, status: string) => void;
    /** Title and per-card controls; rendered at full width. */
    renderTask: (row: Task) => React.ReactNode;
    /** An optional one-click action beside the move menu, such as handing the card off. */
    renderAction?: (row: Task) => React.ReactNode;
    /** Display name for a status; the stored Notion status is unchanged. */
    columnLabel?: (column: string) => string;
    /** Statuses folded by default, such as finished work. */
    folded?: string[];
};

const groupId = (column: string) => `home-ai-status:${column}`;
const collisionDetection: CollisionDetection = (args) => {
    const underPointer = pointerWithin(args);
    return underPointer.length ? underPointer : rectIntersection(args);
};
const foldedKey = 'open-carter:ai-task-folded:v1';
const foldedSchema = z.array(z.string());
const readFolded = (fallback: string[]) => {
    try {
        const saved = foldedSchema.safeParse(JSON.parse(localStorage.getItem(foldedKey) ?? 'null'));
        return saved.success ? saved.data : fallback;
    } catch { return fallback; }
};

// AI Tasks are read and written as briefs, so each card gets the widget's full
// width in a status-grouped list instead of a narrow kanban column.
const TaskRow: React.FC<{ row: Task; columns: string[] } & Pick<ListProps, 'disabled' | 'onMove' | 'renderTask' | 'renderAction' | 'columnLabel'>> = ({ row, columns, disabled, onMove, renderTask, renderAction, columnLabel }) => {
    const { t } = useI18n();
    const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, isDragging } = useDraggable({ id: row.url, disabled });
    return <div ref={setNodeRef} data-home-task={row.url} className={cn('oc-ai-task', isDragging && 'relative z-20 opacity-70')} style={{ transform: CSS.Translate.toString(transform) }}>
        <Button ref={setActivatorNodeRef} type="button" variant="ghost" size="icon" className="mt-0.5 size-5 shrink-0 touch-none select-none cursor-grab active:cursor-grabbing" disabled={disabled} {...attributes} {...listeners} tabIndex={-1} aria-describedby={undefined} aria-label={t('home.dragTask')} title={t('home.dragTask')}><Icon name="draggable" className="size-3" /></Button>
        <div className="min-w-0 flex-1">{renderTask(row)}</div>
        <div className="flex shrink-0 items-center gap-1">
            {renderAction?.(row)}
            <DropdownMenu><DropdownMenuTrigger asChild><Button data-home-task-move type="button" variant="ghost" size="icon" className="size-6" disabled={disabled} aria-label={t('home.moveTask')} title={t('home.moveTask')}><Icon name="arrow-left-right" className="size-3.5" /></Button></DropdownMenuTrigger>
                <DropdownMenuContent>{columns.map((column) => <DropdownMenuItem key={column} nativeButton render={<button type="button" />} disabled={column === row.status} onSelect={() => onMove(row.url, column)}>{columnLabel?.(column) ?? column}</DropdownMenuItem>)}</DropdownMenuContent>
            </DropdownMenu>
        </div>
    </div>;
};

const StatusGroup: React.FC<{ column: string; label: string; count: number; open: boolean; disabled: boolean; onToggle: () => void; children: React.ReactNode }> = ({ column, label, count, open, disabled, onToggle, children }) => {
    const { setNodeRef, isOver } = useDroppable({ id: groupId(column), disabled });
    return <section ref={setNodeRef} data-home-status={column} className={cn('oc-ai-group', isOver && 'oc-ai-group-over')}>
        <h3 className="oc-ai-group-heading">
            <button type="button" className="oc-ai-group-toggle" aria-expanded={open} onClick={onToggle}>
                <Icon name={open ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">{label}</span>
            </button>
            <span className="oc-home-count ml-auto">{count}</span>
        </h3>
        {open && count > 0 && <div className="oc-ai-group-rows">{children}</div>}
    </section>;
};

export const HomeAiTaskList: React.FC<ListProps> = ({ board, disabled, onMove, renderTask, renderAction, columnLabel, folded = [] }) => {
    const [closed, setClosed] = React.useState(() => readFolded(folded));
    const toggle = (column: string) => setClosed((current) => {
        const next = current.includes(column) ? current.filter((item) => item !== column) : [...current, column];
        try { localStorage.setItem(foldedKey, JSON.stringify(next)); } catch { /* folding is a view preference only */ }
        return next;
    });
    const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 8 } }), useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }));
    const move = ({ active, over }: DragEndEvent) => {
        if (disabled || !over) return;
        const row = board.rows.find((item) => item.url === active.id);
        const column = board.columns.find((item) => groupId(item) === over.id);
        if (row && column && row.status !== column) onMove(row.url, column);
    };
    const row = (item: Task) => <TaskRow key={item.url} row={item} columns={board.columns} disabled={disabled} onMove={onMove} renderTask={renderTask} renderAction={renderAction} columnLabel={columnLabel} />;
    const unassigned = board.rows.filter((item) => !board.columns.includes(item.status ?? ''));
    return <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragEnd={move}>
        <div className="oc-ai-list">
            {board.columns.map((column) => {
                const rows = board.rows.filter((item) => item.status === column);
                return <StatusGroup key={column} column={column} label={columnLabel?.(column) ?? column} count={rows.length} open={!closed.includes(column)} disabled={disabled} onToggle={() => toggle(column)}>{rows.map(row)}</StatusGroup>;
            })}
            {unassigned.length > 0 && <div className="oc-ai-group-rows">{unassigned.map(row)}</div>}
        </div>
    </DndContext>;
};

import React from 'react';
import { DndContext, MouseSensor, TouchSensor, KeyboardSensor, closestCenter, pointerWithin, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type Announcements } from '@dnd-kit/core';
import { SortableContext, useSortable, rectSortingStrategy, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import { defaultHomeLayout, restoreHomeLayout, homeLayoutSections, homeColumnWidth, resizeHomeColumns, moveHomeWidget, homeDropSchema, type HomeLayoutItem, type HomeLayoutSection } from './home-widget-layout';

type Widgets = { [Id in HomeLayoutItem['id']]: { label: string; content: React.ReactNode } };
const storageKey = 'openchamber.personalHome.layout.v2';
const loadLayout = () => {
    try { return restoreHomeLayout(localStorage.getItem(storageKey), localStorage.getItem('openchamber.personalHome.layout.v1')); }
    catch { return defaultHomeLayout(); }
};
// Prefer the widget under the pointer, then the empty space in its column.
const homeCollision: CollisionDetection = (args) => {
    const hits = pointerWithin(args);
    const widgetHits = hits.filter(({ id }) => args.droppableContainers.find((container) => container.id === id)?.data.current?.kind === 'widget');
    return widgetHits.length ? widgetHits : hits.length ? hits : closestCenter(args);
};

const WidgetColumn: React.FC<{ section: string; column: HomeLayoutItem['column']; children: React.ReactNode; dragging: boolean }> = ({ section, column, children, dragging }) => {
    const { setNodeRef, isOver } = useDroppable({ id: `home-column:${section}:${column}`, data: { kind: 'column', section, column } });
    return <div ref={setNodeRef} className="oc-home-column-stack" data-drop-target={dragging && isOver ? 'true' : undefined}>{children}</div>;
};

const WidgetColumns: React.FC<{ section: HomeLayoutSection; widgets: Widgets; dragging: boolean; onWidth: (width: number) => void; onSpan: (id: HomeLayoutItem['id']) => void }> = ({ section, widgets, dragging, onWidth, onSpan }) => {
    const { t } = useI18n();
    const ref = React.useRef<HTMLDivElement>(null);
    const [available, setAvailable] = React.useState(0);
    const [preview, setPreview] = React.useState<number | null>(null);
    const current = React.useRef<number | null>(null);
    React.useEffect(() => {
        const element = ref.current;
        if (!element) return;
        const observer = new ResizeObserver(([entry]) => setAvailable(Math.max(0, entry.contentRect.width - 16)));
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    const minimum = available > 0 ? Math.min(50, Math.max(20, 240 / available * 100)) : 20;
    const maximum = 100 - minimum;
    const clamp = (value: number) => Math.max(minimum, Math.min(maximum, value));
    const width = clamp(preview ?? homeColumnWidth(section.items));
    const pointerWidth = (event: React.PointerEvent<HTMLDivElement>) => {
        const bounds = ref.current?.getBoundingClientRect();
        return bounds && available > 0 ? clamp((event.clientX - bounds.left - 8) / available * 100) : width;
    };
    const cancel = () => { current.current = null; setPreview(null); };
    const style: React.CSSProperties & { '--home-left-width': string; '--home-right-width': string } = { '--home-left-width': `${width}fr`, '--home-right-width': `${100 - width}fr` };
    return <div ref={ref} className="oc-home-columns" style={style}>
        <WidgetColumn section={section.id} column="left" dragging={dragging}>
            {section.items.filter((item) => item.column === 'left').map((item) => <HomeWidget key={item.id} item={item} section={section.id} widget={widgets[item.id]} onResize={() => onSpan(item.id)} />)}
        </WidgetColumn>
        <div className="oc-home-divider" role="separator" tabIndex={0} aria-orientation="vertical" aria-label={t('home.resizeColumns')}
            aria-valuemin={Math.ceil(minimum)} aria-valuemax={Math.floor(maximum)} aria-valuenow={Math.round(width)} data-resizing={preview !== null ? 'true' : undefined}
            onPointerDown={(event) => {
                if (event.button !== 0 || dragging) return;
                event.preventDefault();
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
                current.current = width; setPreview(width);
            }}
            onPointerMove={(event) => { if (current.current !== null) { current.current = pointerWidth(event); setPreview(current.current); } }}
            onPointerUp={(event) => {
                if (current.current === null) return;
                onWidth(pointerWidth(event)); cancel(); event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={cancel} onLostPointerCapture={cancel}
            onKeyDown={(event) => {
                if (event.key === 'Escape') { cancel(); return; }
                const step = event.shiftKey ? 10 : 2;
                const next = event.key === 'ArrowLeft' ? width - step : event.key === 'ArrowRight' ? width + step : event.key === 'Home' ? minimum : event.key === 'End' ? maximum : undefined;
                if (next === undefined) return;
                event.preventDefault(); onWidth(clamp(next));
            }} />
        <WidgetColumn section={section.id} column="right" dragging={dragging}>
            {section.items.filter((item) => item.column === 'right').map((item) => <HomeWidget key={item.id} item={item} section={section.id} widget={widgets[item.id]} onResize={() => onSpan(item.id)} />)}
        </WidgetColumn>
    </div>;
};

const HomeWidget: React.FC<{ item: HomeLayoutItem; section: string; widget: Widgets[HomeLayoutItem['id']]; onResize: () => void }> = ({ item, section, widget, onResize }) => {
    const { t } = useI18n();
    const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, data: { kind: 'widget', section, column: item.column } });
    return <div ref={setNodeRef} data-home-widget={item.id} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn('oc-home-card', item.wide && 'oc-home-wide', isDragging && 'oc-home-dragging')}>
        <div className="oc-home-widget-controls">
            <Button type="button" ref={setActivatorNodeRef} variant="ghost" size="icon" {...attributes} {...listeners}
                className="size-6 touch-none select-none cursor-grab text-muted-foreground active:cursor-grabbing"
                title={t('chat.workStatus.sections.reorder', { label: widget.label })} aria-label={t('chat.workStatus.sections.reorder', { label: widget.label })}>
                <Icon name="draggable" className="size-3.5" />
            </Button>
            <Button type="button" variant="ghost" size="sm" className="h-6 text-[10px] text-muted-foreground" onClick={onResize}
                aria-label={`${widget.label}: ${t(item.wide ? 'home.halfWidth' : 'home.fullWidth')}`}>
                <Icon name="arrow-left-right" className="size-3" />{t(item.wide ? 'home.halfWidth' : 'home.fullWidth')}
            </Button>
        </div>
        <div className="oc-home-widget-content">{widget.content}</div>
    </div>;
};

export const HomeWidgetLayout: React.FC<{ widgets: Widgets }> = ({ widgets }) => {
    const { t } = useI18n();
    const [layout, setLayout] = React.useState(loadLayout);
    const [dragging, setDragging] = React.useState(false);
    const [saveFailed, setSaveFailed] = React.useState(false);
    const sensors = useSensors(
        useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );
    const update = (next: HomeLayoutItem[]) => {
        setLayout(next);
        try { localStorage.setItem(storageKey, JSON.stringify(next)); setSaveFailed(false); }
        catch { setSaveFailed(true); }
    };
    const onDragEnd = ({ active, over }: DragEndEvent) => {
        setDragging(false);
        if (!over || active.id === over.id) return;
        const target = homeDropSchema.safeParse(over.data.current);
        if (!target.success) return;
        const rect = active.rect.current.translated;
        const after = rect ? rect.top + rect.height / 2 > over.rect.top + over.rect.height / 2 : false;
        update(moveHomeWidget(layout, String(active.id), String(over.id), target.data, after));
    };
    const position = (activeId: string | number, overId: string | number = activeId) => {
        const item = layout.find(({ id }) => id === activeId);
        return item ? t('chat.workStatus.sections.position', { label: widgets[item.id].label, position: Math.max(1, layout.findIndex(({ id }) => id === overId) + 1), count: layout.length }) : undefined;
    };
    const announcements: Announcements = {
        onDragStart: ({ active }) => position(active.id),
        onDragOver: ({ active, over }) => over ? position(active.id, over.id) : undefined,
        onDragEnd: ({ active, over }) => over ? position(active.id, over.id) : t('chat.workStatus.sections.dragCancelled'),
        onDragCancel: () => t('chat.workStatus.sections.dragCancelled'),
    };
    return <div className="oc-home-dashboard-wrap">
        <div className="oc-home-layout-bar"><p className="flex-1">{t('home.layoutHint')}</p>
            <Button type="button" size="sm" variant="ghost" onClick={() => update(defaultHomeLayout())}>{t('home.resetLayout')}</Button>
        </div>
        {saveFailed && <p role="alert" className="oc-home-empty text-destructive">{t('settings.common.status.saveFailed')}</p>}
        <DndContext sensors={sensors} collisionDetection={homeCollision} onDragStart={() => setDragging(true)} onDragCancel={() => setDragging(false)} onDragEnd={onDragEnd}
            accessibility={{ announcements, screenReaderInstructions: { draggable: t('chat.workStatus.sections.dragInstructions') } }}>
            <SortableContext items={layout.map(({ id }) => id)} strategy={rectSortingStrategy}>
                <div className="oc-home-dashboard">{homeLayoutSections(layout).map((section) => <React.Fragment key={section.id}>
                    {section.items.length > 0 && <WidgetColumns section={section} widgets={widgets} dragging={dragging}
                        onWidth={(width) => update(resizeHomeColumns(layout, section.id, width))}
                        onSpan={(id) => update(layout.map((entry) => entry.id === id ? { ...entry, wide: !entry.wide } : entry))} />}
                    {section.full && <HomeWidget item={section.full} section={section.id} widget={widgets[section.full.id]}
                        onResize={() => update(layout.map((entry) => entry.id === section.full?.id ? { ...entry, wide: false } : entry))} />}
                </React.Fragment>)}</div>
            </SortableContext>
        </DndContext>
    </div>;
};

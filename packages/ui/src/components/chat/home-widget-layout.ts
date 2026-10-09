import { z } from 'zod';

const widgetIds = ['working', 'recent', 'tasks', 'calendar', 'habits', 'projects', 'shortcuts'] as const;
const legacySchema = z.array(z.object({ id: z.enum(widgetIds), wide: z.boolean() }));
const layoutSchema = z.array(z.object({ id: z.enum(widgetIds), wide: z.boolean(), column: z.enum(['left', 'right']), width: z.number().min(20).max(80).catch(50) }));
export type HomeLayoutItem = z.infer<typeof layoutSchema>[number];
export type HomeLayoutSection = { id: string; items: HomeLayoutItem[]; full?: HomeLayoutItem };
export const homeDropSchema = z.object({ kind: z.enum(['widget', 'column']), section: z.string(), column: z.enum(['left', 'right']) });

const defaultColumns = { working: 'left', recent: 'right', tasks: 'left', calendar: 'left', habits: 'right', projects: 'left', shortcuts: 'right' } as const;
export const defaultHomeLayout = (): HomeLayoutItem[] => widgetIds.map((id) => ({ id, wide: id === 'tasks', column: defaultColumns[id], width: 50 }));
export function restoreHomeLayout(saved: string | null, legacy: string | null): HomeLayoutItem[] {
    let items: HomeLayoutItem[] = [];
    try {
        const current = layoutSchema.safeParse(JSON.parse(saved ?? 'null'));
        if (current.success) items = current.data;
        else {
            const old = legacySchema.safeParse(JSON.parse(legacy ?? 'null'));
            let columnIndex = 0;
            if (old.success) items = old.data.map((item) => {
                const column = columnIndex % 2 === 0 ? 'left' : 'right';
                columnIndex = item.wide ? 0 : columnIndex + 1;
                return { ...item, column, width: 50 };
            });
        }
    } catch { /* A malformed saved layout restores the standard home. */ }
    const seen = new Set<HomeLayoutItem['id']>();
    const unique = items.filter(({ id }) => { if (seen.has(id)) return false; seen.add(id); return true; });
    return [...unique, ...defaultHomeLayout().filter(({ id }) => !seen.has(id))];
}

export function homeLayoutSections(layout: HomeLayoutItem[]): HomeLayoutSection[] {
    const sections: HomeLayoutSection[] = [];
    let section: HomeLayoutSection = { id: 'start', items: [] };
    for (const item of layout) {
        if (item.wide) {
            sections.push({ ...section, full: item });
            section = { id: item.id, items: [] };
        } else section.items.push(item);
    }
    sections.push(section);
    return sections;
}

// Both independently stacked columns share one divider. Keep each widget's
// preference with it when reordering or changing full-width section boundaries.
export function homeColumnWidth(items: HomeLayoutItem[]): number {
    const first = items[0];
    return first ? first.column === 'left' ? first.width : 100 - first.width : 50;
}

export function resizeHomeColumns(layout: HomeLayoutItem[], sectionId: string, width: number): HomeLayoutItem[] {
    if (!Number.isFinite(width)) return layout;
    const section = homeLayoutSections(layout).find(({ id }) => id === sectionId);
    if (!section) return layout;
    const ids = new Set(section.items.map(({ id }) => id));
    const left = Math.min(80, Math.max(20, width));
    return layout.map((item) => ids.has(item.id) ? { ...item, width: item.column === 'left' ? left : 100 - left } : item);
}

export function moveHomeWidget(layout: HomeLayoutItem[], activeId: string, overId: string, target: z.infer<typeof homeDropSchema>, after: boolean): HomeLayoutItem[] {
    const active = layout.find(({ id }) => id === activeId);
    if (!active || activeId === overId) return layout;
    const next = layout.filter(({ id }) => id !== activeId);
    let index: number;
    if (target.kind === 'widget') {
        index = next.findIndex(({ id }) => id === overId);
        if (index < 0) return layout;
        if (after) index += 1;
    } else {
        const section = homeLayoutSections(next).find(({ id }) => id === target.section);
        if (!section) return layout;
        index = section.full ? next.findIndex(({ id }) => id === section.full?.id) : next.length;
    }
    const targetSection = homeLayoutSections(next).find(({ id }) => id === target.section);
    const width = targetSection ? homeColumnWidth(targetSection.items) : 50;
    next.splice(index, 0, { ...active, column: target.column, width: target.column === 'left' ? width : 100 - width });
    return next;
}

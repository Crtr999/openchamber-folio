import { describe, expect, test } from 'bun:test';
import { defaultHomeLayout, restoreHomeLayout, homeLayoutSections, homeColumnWidth, resizeHomeColumns, moveHomeWidget } from './home-widget-layout';

const previous = JSON.stringify([
    { id: 'tasks', wide: false }, { id: 'habits', wide: false },
    { id: 'working', wide: false }, { id: 'recent', wide: false },
    { id: 'calendar', wide: false }, { id: 'projects', wide: false }, { id: 'shortcuts', wide: false },
]);
describe('personal home column layout', () => {
    test('migrates v2 half/full layouts without losing order, columns or spans', () => {
        const saved = JSON.stringify([{ id: 'habits', wide: false, column: 'right' }, { id: 'tasks', wide: true, column: 'left' }]);
        const layout = restoreHomeLayout(saved, null);
        expect(layout.slice(0, 2)).toEqual([{ id: 'habits', wide: false, column: 'right', width: 50 }, { id: 'tasks', wide: true, column: 'left', width: 50 }]);
    });
    test('resizes smoothly, complements adjacent columns and persists exact proportions', () => {
        const layout = restoreHomeLayout(null, previous);
        const resized = resizeHomeColumns(layout, 'start', 61.37);
        expect(homeColumnWidth(resized)).toBe(61.37);
        expect(homeLayoutSections(resized)[0].items.filter(({ column }) => column === 'right').every(({ width }) => width === 38.63)).toBe(true);
        expect(restoreHomeLayout(JSON.stringify(resized), previous)).toEqual(resized);
        expect(resized.map(({ id }) => id)).toEqual(layout.map(({ id }) => id));
    });
    test('clamps saved proportions and only changes the requested section', () => {
        const layout = restoreHomeLayout(null, previous).map((item) => item.id === 'working' ? { ...item, wide: true } : item);
        const resized = resizeHomeColumns(layout, 'start', 99);
        expect(homeColumnWidth(homeLayoutSections(resized)[0].items)).toBe(80);
        expect(resized.find(({ id }) => id === 'working')).toEqual(layout.find(({ id }) => id === 'working'));
        expect(homeLayoutSections(resized)[1].items).toEqual(homeLayoutSections(layout)[1].items);
        expect(resizeHomeColumns(layout, 'missing', 40)).toBe(layout);
        expect(resizeHomeColumns(layout, 'start', NaN)).toBe(layout);
        const broken = layout.map((item) => ({ ...item, width: -1 }));
        expect(restoreHomeLayout(JSON.stringify(broken), null).every(({ width }) => width === 50)).toBe(true);
    });
    test('migrates the pictured layout with Recent chats directly below Habits in the right column', () => {
        const layout = restoreHomeLayout(null, previous);
        const first = homeLayoutSections(layout)[0];
        expect(first.items.filter((item) => item.column === 'right').map((item) => item.id)).toEqual(['habits', 'recent', 'projects']);
        expect(first.items.filter((item) => item.column === 'left').map((item) => item.id)).toEqual(['tasks', 'working', 'calendar', 'shortcuts']);
        expect(restoreHomeLayout(JSON.stringify(layout), previous)).toEqual(layout);
    });
    test('moves into empty column space without changing widths or duplicating widgets', () => {
        const layout = restoreHomeLayout(null, previous);
        const moved = moveHomeWidget(layout, 'recent', 'home-column:start:left', { kind: 'column', section: 'start', column: 'left' }, true);
        expect(homeLayoutSections(moved)[0].items.filter((item) => item.column === 'left').at(-1)?.id).toBe('recent');
        expect(moved.find((item) => item.id === 'recent')?.wide).toBe(false);
        expect(new Set(moved.map((item) => item.id)).size).toBe(9);
    });
    test('places above or below a widget in the chosen column', () => {
        const layout = restoreHomeLayout(null, previous);
        const target = { kind: 'widget', section: 'start', column: 'right' } as const;
        const moved = moveHomeWidget(layout, 'working', 'habits', target, true);
        expect(moved.filter((item) => item.column === 'right').map((item) => item.id)).toEqual(['habits', 'working', 'recent', 'projects', 'commitments']);
        expect(moveHomeWidget(layout, 'working', 'habits', target, false)[1].id).toBe('working');
    });
    test('full-width widgets remain barriers between independent column sections', () => {
        const layout = restoreHomeLayout(null, previous).map((item) => item.id === 'working' ? { ...item, wide: true } : item);
        const sections = homeLayoutSections(layout);
        expect(sections[0].full?.id).toBe('working');
        expect(sections[1].id).toBe('working');
        const moved = moveHomeWidget(layout, 'recent', 'home-column:start:right', { kind: 'column', section: 'start', column: 'right' }, true);
        expect(homeLayoutSections(moved)[0].items.filter((item) => item.column === 'right').map((item) => item.id)).toEqual(['habits', 'recent']);
        expect(moved.find((item) => item.id === 'working')?.wide).toBe(true);
    });
    test('ignores stale drop targets and repairs duplicate saved entries', () => {
        const layout = restoreHomeLayout(null, previous);
        expect(moveHomeWidget(layout, 'recent', 'removed', { kind: 'widget', section: 'start', column: 'right' }, false)).toEqual(layout);
        const restored = restoreHomeLayout(JSON.stringify([layout[0], layout[0]]), null);
        expect(new Set(restored.map((item) => item.id)).size).toBe(9);
        expect(restored).toHaveLength(9);
    });
    test('a fresh Home leads with full-width Friends; saved layouts keep their order and gain Friends below', () => {
        expect(defaultHomeLayout()[0]).toEqual({ id: 'friends', wide: true, column: 'left', width: 50 });
        const saved = restoreHomeLayout(null, previous).filter(({ id }) => id !== 'friends');
        const restored = restoreHomeLayout(JSON.stringify(saved), null);
        expect(restored.slice(0, saved.length)).toEqual(saved);
        expect(restored.at(-1)).toEqual({ id: 'friends', wide: true, column: 'left', width: 50 });
        expect(restoreHomeLayout(JSON.stringify(restored), null)).toEqual(restored);
    });
});

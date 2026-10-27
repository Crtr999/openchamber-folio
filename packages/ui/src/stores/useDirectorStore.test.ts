import { beforeEach, expect, test } from 'bun:test';
import { useDirectorStore } from './useDirectorStore';

const friend = { name: 'Business Launch', body: 'star', color: 'amber' } as const;

beforeEach(() => { useDirectorStore.setState({ run: null, blocked: [], enabled: false }); });

test('a run is owned by its id, so a stale update cannot touch a newer run', () => {
  const first = useDirectorStore.getState().begin({ directory: '/a', original: 'one', friend });
  useDirectorStore.getState().end(first);
  const second = useDirectorStore.getState().begin({ directory: '/a', original: 'two', friend });
  useDirectorStore.getState().update(first, { phase: 'deliver', improved: 'stale' });
  expect(useDirectorStore.getState().run).toMatchObject({ id: second, phase: 'summon', original: 'two' });
  useDirectorStore.getState().update(second, { phase: 'compose', improved: 'better', used: { rules: true, memoryFile: false, entries: 3 } });
  expect(useDirectorStore.getState().run?.improved).toBe('better');
  useDirectorStore.getState().end(first);
  expect(useDirectorStore.getState().run?.id).toBe(second);
});

test('a refused folder is remembered once', () => {
  useDirectorStore.getState().block('/zdr'); useDirectorStore.getState().block('/zdr');
  expect(useDirectorStore.getState().blocked).toEqual(['/zdr']);
});

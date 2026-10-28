import React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isPathGuarded } from '@/lib/zdrLock';
import { useZdrLockStore } from '@/stores/useZdrLockStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { dismissHomeSuggestion, readHomeSuggestions, type HomeSuggestion } from '@/lib/homeSuggestions';
import { HomeSuggestionRow } from './HomeSuggestionRow';
import './HomeSuggestions.css';

/**
 * Web and Electron full Home use the server inbox via runtimeFetch. Hosted
 * mobile, Capacitor and VS Code keep their existing compact draft UI and do
 * not mount this component or request a native calendar/Outlook connection.
 */
export function HomeSuggestions() {
  const { t } = useI18n();
  const projects = useProjectsStore(state => state.projects);
  const loaded = useZdrLockStore(state => state.loaded);
  const guarded = useZdrLockStore(state => state.directories);
  const [runtime, setRuntime] = React.useState(getRuntimeKey);
  const [revision, refresh] = React.useReducer(value => value + 1, 0);
  const [snapshot, setSnapshot] = React.useState<{ runtime: string; items: HomeSuggestion[]; failed: boolean }>({ runtime, items: [], failed: false });
  const [loading, setLoading] = React.useState(false);
  const [pending, setPending] = React.useState<ReadonlySet<string>>(new Set());
  const dismissed = React.useRef(new Set<string>());
  const sequence = React.useRef(0);
  const mutations = React.useRef(new Set<AbortController>());
  const keyOf = (item: HomeSuggestion) => `${item.projectId}:${item.id}`;
  // This is defense in depth. The server must authorize the folder before
  // reading its inbox, even when a ZDR folder has been unlocked by its owner.
  const folders = React.useMemo(() => loaded ? projects.filter(project => !isPathGuarded(guarded, project.path)) : [], [projects, loaded, guarded]);

  React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
    sequence.current++;
    mutations.current.forEach(controller => controller.abort());
    mutations.current.clear();
    dismissed.current.clear();
    setPending(new Set());
    setRuntime(getRuntimeKey());
  }), []);

  React.useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    // Reviews can finish while Home stays open. Read only their existing inbox
    // receipts, never wake a friend or invoke a source reader to fill this row.
    const timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 60_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  React.useEffect(() => {
    if (!loaded || isVSCodeRuntime()) return;
    const generation = ++sequence.current;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]);
    const slow = setTimeout(() => setLoading(true), 300);
    void readHomeSuggestions(folders, signal).then(result => {
      if (generation !== sequence.current || runtime !== getRuntimeKey()) return;
      setSnapshot(previous => ({ runtime,
        items: [...result.items, ...(previous.runtime === runtime ? previous.items.filter(item => result.failedProjectIds.includes(item.projectId)) : [])]
          .filter(item => !dismissed.current.has(keyOf(item)))
          .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)),
        failed: result.failedProjectIds.length > 0,
      }));
    }).catch(() => {
      if (!controller.signal.aborted && generation === sequence.current && runtime === getRuntimeKey()) {
        setSnapshot(previous => ({ ...previous, failed: true }));
      }
    }).finally(() => {
      clearTimeout(slow);
      if (generation === sequence.current) setLoading(false);
    });
    return () => { clearTimeout(slow); controller.abort(); };
  }, [folders, loaded, runtime, revision]);

  React.useEffect(() => {
    const controllers = mutations.current;
    return () => controllers.forEach(controller => controller.abort());
  }, []);

  const dismiss = async (item: HomeSuggestion) => {
    const key = keyOf(item);
    if (pending.has(key)) return;
    const owner = getRuntimeKey();
    const controller = new AbortController();
    mutations.current.add(controller);
    setPending(previous => new Set([...previous, key]));
    try {
      await dismissHomeSuggestion(item, AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]));
      if (owner !== getRuntimeKey() || controller.signal.aborted) return;
      dismissed.current.add(key);
      setSnapshot(previous => ({ ...previous, items: previous.items.filter(entry => keyOf(entry) !== key) }));
    } catch {
      if (owner === getRuntimeKey() && !controller.signal.aborted) setSnapshot(previous => ({ ...previous, failed: true }));
    } finally {
      mutations.current.delete(controller);
      if (owner === getRuntimeKey()) setPending(previous => new Set([...previous].filter(value => value !== key)));
    }
  };

  if (!loaded || isVSCodeRuntime() || snapshot.runtime !== runtime || runtime !== getRuntimeKey()) return null;
  const items = snapshot.items.filter(item => folders.some(folder => folder.id === item.projectId && folder.path === item.directory)).slice(0, 3);
  if (!items.length && !loading && !snapshot.failed) return null;
  return <div className="oc-home-suggestions" aria-label={t('companion.inbox')}>
    <ul>{items.map(item => <HomeSuggestionRow key={keyOf(item)} item={item} pending={pending.has(keyOf(item))}
      onOpen={() => {
        const policy = useZdrLockStore.getState();
        if (runtime !== getRuntimeKey() || !policy.loaded || isPathGuarded(policy.directories, item.directory)) return;
        // Selecting the original result opens its context. It does not submit a
        // prompt, copy private text to another folder, or replace the draft.
        useSessionUIStore.getState().setCurrentSession(item.id, item.directory);
      }} onDismiss={() => void dismiss(item)} />)}</ul>
    <div role="status" className="oc-home-suggestions-status">
      {loading && !items.length ? t('common.loading') : null}
      {snapshot.failed && <><span>{t('companion.error')}</span><Button type="button" variant="link" size="xs" onClick={refresh}>{t('companion.refresh')}</Button></>}
    </div>
  </div>;
}

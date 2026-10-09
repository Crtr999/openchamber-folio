import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useWebviewNavigation } from '@/components/browser/useWebviewNavigation';
import { useMuseStore } from '@/stores/useMuseStore';
import { MUSE_URL, MUSE_PARTITION } from '@/lib/muse/website';

const retainWebsiteNavigation = () => {};

/** One retained website tab. Muse owns messages, memory, goals and navigation. */
export function MuseWorkspace({ visible }: { visible: boolean }): React.ReactNode {
  const { t } = useI18n();
  const [hasOpened, setHasOpened] = React.useState(false);
  const [webview, setWebview] = React.useState<WebviewElement | null>(null);
  const attachWebview = React.useCallback((node: WebviewElement | null) => {
    // React treats webview as an unknown HTML tag and drops boolean allowpopups.
    // Electron's handler denies new windows and loads these links in this guest.
    node?.setAttribute('allowpopups', '');
    setWebview(node);
  }, []);
  const request = useMuseStore(state => state.request);
  const pageUrl = useMuseStore(state => state.pageUrl);
  const saved = useMuseStore(state => state.savedPages.some(page => page.url === state.pageUrl));
  const navigation = useWebviewNavigation(webview, { initialUrl: MUSE_URL, onUrlChange: retainWebsiteNavigation });
  const handledRequest = React.useRef(0);
  React.useEffect(() => {
    if (visible && !hasOpened) {
      // The initial src already opens Home. Don't reload the newly attached guest.
      if (!request || request.action === 'home' || request.action === 'refresh') handledRequest.current = request?.sequence ?? 0;
      setHasOpened(true);
    }
  }, [visible, hasOpened, request]);

  React.useEffect(() => {
    if (navigation.status.kind === 'ready') useMuseStore.getState().adoptPageTitle(navigation.url, navigation.title);
    else useMuseStore.getState().adoptPageTitle('', '');
  }, [navigation.url, navigation.title, navigation.status.kind]);

  React.useEffect(() => {
    if (!webview || !visible || !request || request.sequence === handledRequest.current || navigation.status.kind === 'loading' || navigation.status.kind === 'idle') return;
    handledRequest.current = request.sequence;
    if (request.action === 'refresh') webview.reload();
    else void webview.loadURL(request.action === 'home' ? MUSE_URL : request.action.url);
  }, [webview, visible, request, navigation.status.kind]);

  if (!visible && !hasOpened) return null;
  return <section className={visible ? 'absolute inset-0 z-10 flex flex-col bg-background' : 'hidden'} aria-label="Muse" aria-hidden={!visible || undefined}>
    <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
      <div className="flex-1" />
      <Button size="xs" variant="ghost" disabled={!navigation.canGoBack} aria-label={t('contextPanel.browser.back')} onClick={() => webview?.goBack()}><Icon name="arrow-left" className="size-3.5" /></Button>
      <Button size="xs" variant="ghost" disabled={!navigation.canGoForward} aria-label={t('contextPanel.browser.forward')} onClick={() => webview?.goForward()}><Icon name="arrow-right" className="size-3.5" /></Button>
      <Button size="xs" variant="ghost" disabled={!pageUrl} aria-pressed={saved} aria-label={t(saved ? 'muse.unpin' : 'muse.pin')} title={t(saved ? 'muse.unpin' : 'muse.pin')} onClick={() => useMuseStore.getState().toggleSavedPage()}><Icon name="pushpin" className="size-3.5" /></Button>
      <Button size="xs" variant="ghost" onClick={() => webview?.focus()}>{t('muse.full')}</Button>
      <Button size="xs" variant="ghost" aria-label={t('contextPanel.browser.reload')} onClick={() => webview?.reload()}><Icon name="refresh" className="size-3.5" /></Button>
    </div>
    <p className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-muted-foreground" role="status">{t('muse.historyUnavailable')}</p>
    <div className="relative min-h-0 flex-1">
      <webview ref={attachWebview} src={MUSE_URL} partition={MUSE_PARTITION} style={{ width: '100%', height: '100%', border: 'none' }} />
      {navigation.status.kind === 'failed' && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6">
        <p>{t('contextPanel.browser.loadFailed')}</p>
        <Button variant="outline" onClick={() => webview?.reload()}>{t('contextPanel.browser.reload')}</Button>
      </div>}
    </div>
  </section>;
}

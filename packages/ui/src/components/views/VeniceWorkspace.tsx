import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { useI18n } from '@/lib/i18n';
import { useWebviewNavigation } from '@/components/browser/useWebviewNavigation';
import { useVeniceStore } from '@/stores/useVeniceStore';
import { useUIStore } from '@/stores/useUIStore';
import { VENICE_URL, VENICE_PARTITION } from '@/lib/venice/website';

const retainWebsiteNavigation = () => {};

/** A singleton retained guest, with Venice's own sidebar and account history. */
export function VeniceWorkspace({ visible }: { visible: boolean }): React.ReactNode {
  const { t } = useI18n();
  const blocked = useEnterpriseMode();
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [initialUrl, setInitialUrl] = React.useState<string | null>(null);
  const hasOpened = initialUrl !== null;
  const [webview, setWebview] = React.useState<WebviewElement | null>(null);
  const attachWebview = React.useCallback((node: WebviewElement | null) => {
    // Main denies popup windows and navigates this guest in place.
    node?.setAttribute('allowpopups', '');
    setWebview(node);
  }, []);
  const request = useVeniceStore(state => state.request);
  const pageTitle = useVeniceStore(state => state.pageTitle);
  const pageUrl = useVeniceStore(state => state.pageUrl);
  const savedPages = useVeniceStore(state => state.savedPages);
  const saved = savedPages.some(page => page.url === pageUrl);
  const headerTabsEnabled = useUIStore(state => state.sessionTabsEnabled);
  const navigation = useWebviewNavigation(webview, { initialUrl: initialUrl ?? VENICE_URL, onUrlChange: retainWebsiteNavigation });
  const handledRequest = React.useRef(0);
  React.useEffect(() => {
    if (visible && !hasOpened) {
      // Resolve on first opening, not app startup: Home must override an older Agent resume.
      handledRequest.current = request?.sequence ?? 0;
      setInitialUrl(request && request.action !== 'home' && request.action !== 'refresh' ? request.action.url
        : request?.action === 'home' ? VENICE_URL : useVeniceStore.getState().resumeUrl ?? VENICE_URL);
    }
  }, [visible, hasOpened, request]);

  React.useEffect(() => {
    if (navigation.status.kind === 'ready') useVeniceStore.getState().adoptPageTitle(navigation.url, navigation.title);
    else useVeniceStore.getState().adoptPageTitle('', '');
  }, [navigation.url, navigation.title, navigation.status.kind]);

  React.useEffect(() => {
    if (!webview || !visible || !request || request.sequence === handledRequest.current || navigation.status.kind === 'loading' || navigation.status.kind === 'idle') return;
    handledRequest.current = request.sequence;
    if (request.action === 'refresh') webview.reload();
    else void webview.loadURL(request.action === 'home' ? VENICE_URL : request.action.url);
  }, [webview, visible, request, navigation.status.kind]);

  if (!visible && !hasOpened) return null;
  if (blocked) return visible ? <section className="absolute inset-0 z-10 bg-background p-6" role="status">{t('venice.blocked')}</section> : null;
  return <section className={visible ? 'absolute inset-0 z-10 flex flex-col bg-background' : 'hidden'} aria-label="Venice" aria-hidden={!visible || undefined}>
    <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
      {headerTabsEnabled ? <div className="min-w-0 flex-1" /> : <div className="min-w-0 flex-1" role="tablist" aria-label="Venice">
        <Button id="venice-website-tab" size="xs" variant="secondary" role="tab" aria-selected="true" aria-controls="venice-website-panel" className="max-w-full gap-1.5" onClick={() => webview?.focus()}>
          <span aria-hidden="true">V</span><span className="truncate">{pageTitle || 'Venice'}</span>
        </Button>
      </div>}
      <Button size="xs" variant="ghost" disabled={!navigation.canGoBack} aria-label={t('contextPanel.browser.back')} onClick={() => webview?.goBack()}><Icon name="arrow-left" className="size-3.5" /></Button>
      <Button size="xs" variant="ghost" disabled={!navigation.canGoForward} aria-label={t('contextPanel.browser.forward')} onClick={() => webview?.goForward()}><Icon name="arrow-right" className="size-3.5" /></Button>
      <span className="px-2 typography-meta text-muted-foreground">{t('venice.openFree')}</span>
      <Button size="xs" variant="ghost" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(value => !value)}>{t('venice.connection')}</Button>
      <Button size="xs" variant="ghost" disabled={!pageUrl} aria-pressed={saved} aria-label={t(saved ? 'venice.unpin' : 'venice.pin')} title={t(saved ? 'venice.unpin' : 'venice.pin')} onClick={() => useVeniceStore.getState().toggleSavedPage()}><Icon name="pushpin" className="size-3.5" /></Button>
      <Button size="xs" variant="ghost" aria-label={t('contextPanel.browser.reload')} onClick={() => webview?.reload()}><Icon name="refresh" className="size-3.5" /></Button>
    </div>
    <p hidden={!detailsOpen} className="shrink-0 border-b border-border px-3 py-1 typography-meta text-muted-foreground">{t('venice.connectionDetails')}</p>
    <div id="venice-website-panel" role={headerTabsEnabled ? undefined : 'tabpanel'} aria-labelledby={headerTabsEnabled ? undefined : 'venice-website-tab'} className="relative min-h-0 flex-1">
      <webview ref={attachWebview} src={initialUrl ?? VENICE_URL} partition={VENICE_PARTITION} style={{ width: '100%', height: '100%', border: 'none' }} />
      {navigation.status.kind === 'failed' && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6">
        <p>{t('contextPanel.browser.loadFailed')}</p>
        <Button variant="outline" onClick={() => webview?.reload()}>{t('contextPanel.browser.reload')}</Button>
      </div>}
    </div>
  </section>;
}

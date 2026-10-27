import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { useI18n } from '@/lib/i18n';
import { useWebviewNavigation } from '@/components/browser/useWebviewNavigation';
import { useGeminiStore } from '@/stores/useGeminiStore';
import { useUIStore } from '@/stores/useUIStore';
import { GEMINI_URL, GEMINI_PARTITION } from '@/lib/gemini/website';

const retainWebsiteNavigation = () => {};

/** A singleton retained guest, with Gemini's own sidebar and account history. */
export function GeminiWorkspace({ visible }: { visible: boolean }): React.ReactNode {
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
  const request = useGeminiStore(state => state.request);
  const pageTitle = useGeminiStore(state => state.pageTitle);
  const pageUrl = useGeminiStore(state => state.pageUrl);
  const savedPages = useGeminiStore(state => state.savedPages);
  const saved = savedPages.some(page => page.url === pageUrl);
  const headerTabsEnabled = useUIStore(state => state.sessionTabsEnabled);
  const navigation = useWebviewNavigation(webview, { initialUrl: initialUrl ?? GEMINI_URL, onUrlChange: retainWebsiteNavigation });
  const handledRequest = React.useRef(0);
  React.useEffect(() => {
    if (visible && !hasOpened) {
      // Resolve on first opening, not app startup: Home must override an older Agent resume.
      handledRequest.current = request?.sequence ?? 0;
      setInitialUrl(request && request.action !== 'home' && request.action !== 'refresh' ? request.action.url
        : request?.action === 'home' ? GEMINI_URL : useGeminiStore.getState().resumeUrl ?? GEMINI_URL);
    }
  }, [visible, hasOpened, request]);

  React.useEffect(() => {
    if (navigation.status.kind === 'ready') useGeminiStore.getState().adoptPageTitle(navigation.url, navigation.title);
    else useGeminiStore.getState().adoptPageTitle('', '');
  }, [navigation.url, navigation.title, navigation.status.kind]);

  React.useEffect(() => {
    if (!webview || !visible || !request || request.sequence === handledRequest.current || navigation.status.kind === 'loading' || navigation.status.kind === 'idle') return;
    handledRequest.current = request.sequence;
    if (request.action === 'refresh') webview.reload();
    else void webview.loadURL(request.action === 'home' ? GEMINI_URL : request.action.url);
  }, [webview, visible, request, navigation.status.kind]);

  if (!visible && !hasOpened) return null;
  if (blocked) return visible ? <section className="absolute inset-0 z-10 bg-background p-6" role="status">{t('gemini.blocked')}</section> : null;
  return <section className={visible ? 'absolute inset-0 z-10 flex flex-col bg-background' : 'hidden'} aria-label="Gemini" aria-hidden={!visible || undefined}>
    <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
      {headerTabsEnabled ? <div className="min-w-0 flex-1" /> : <div className="min-w-0 flex-1" role="tablist" aria-label="Gemini">
        <Button id="gemini-website-tab" size="xs" variant="secondary" role="tab" aria-selected="true" aria-controls="gemini-website-panel" className="max-w-full gap-1.5" onClick={() => webview?.focus()}>
          <span aria-hidden="true">G</span><span className="truncate">{pageTitle || 'Gemini'}</span>
        </Button>
      </div>}
      <Button size="xs" variant="ghost" disabled={!navigation.canGoBack} aria-label={t('contextPanel.browser.back')} onClick={() => webview?.goBack()}><Icon name="arrow-left" className="size-3.5" /></Button>
      <Button size="xs" variant="ghost" disabled={!navigation.canGoForward} aria-label={t('contextPanel.browser.forward')} onClick={() => webview?.goForward()}><Icon name="arrow-right" className="size-3.5" /></Button>
      <span className="px-2 typography-meta text-muted-foreground">{t('gemini.openFree')}</span>
      <Button size="xs" variant="ghost" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(value => !value)}>{t('gemini.connection')}</Button>
      <Button size="xs" variant="ghost" disabled={!pageUrl} aria-pressed={saved} aria-label={t(saved ? 'gemini.unpin' : 'gemini.pin')} title={t(saved ? 'gemini.unpin' : 'gemini.pin')} onClick={() => useGeminiStore.getState().toggleSavedPage()}><Icon name="pushpin" className="size-3.5" /></Button>
      <Button size="xs" variant="ghost" aria-label={t('contextPanel.browser.reload')} onClick={() => webview?.reload()}><Icon name="refresh" className="size-3.5" /></Button>
    </div>
    <p hidden={!detailsOpen} className="shrink-0 border-b border-border px-3 py-1 typography-meta text-muted-foreground">{t('gemini.connectionDetails')}</p>
    <div id="gemini-website-panel" role={headerTabsEnabled ? undefined : 'tabpanel'} aria-labelledby={headerTabsEnabled ? undefined : 'gemini-website-tab'} className="relative min-h-0 flex-1">
      <webview ref={attachWebview} src={initialUrl ?? GEMINI_URL} partition={GEMINI_PARTITION} style={{ width: '100%', height: '100%', border: 'none' }} />
      {navigation.status.kind === 'failed' && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6">
        <p>{t('contextPanel.browser.loadFailed')}</p>
        <Button variant="outline" onClick={() => webview?.reload()}>{t('contextPanel.browser.reload')}</Button>
      </div>}
    </div>
  </section>;
}

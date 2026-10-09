import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { ClaudeLogo } from '@/components/ui/ClaudeLogo';
import { useI18n } from '@/lib/i18n';
import { useWebviewNavigation } from '@/components/browser/useWebviewNavigation';
import { useClaudeStore } from '@/stores/useClaudeStore';
import { useUIStore } from '@/stores/useUIStore';
import { CLAUDE_URL, CLAUDE_PARTITION } from '@/lib/claude/website';

const retainWebsiteNavigation = () => {};

/** A singleton retained guest, with Claude's own sidebar and account history. */
export function ClaudeWorkspace({ visible }: { visible: boolean }): React.ReactNode {
  const { t } = useI18n();
  const [hasOpened, setHasOpened] = React.useState(false);
  const [webview, setWebview] = React.useState<WebviewElement | null>(null);
  const attachWebview = React.useCallback((node: WebviewElement | null) => {
    // Main denies popup windows and navigates this guest in place.
    node?.setAttribute('allowpopups', '');
    setWebview(node);
  }, []);
  const request = useClaudeStore(state => state.request);
  const pageTitle = useClaudeStore(state => state.pageTitle);
  const pageUrl = useClaudeStore(state => state.pageUrl);
  const savedPages = useClaudeStore(state => state.savedPages);
  const saved = savedPages.some(page => page.url === pageUrl);
  const headerTabsEnabled = useUIStore(state => state.sessionTabsEnabled);
  const navigation = useWebviewNavigation(webview, { initialUrl: CLAUDE_URL, onUrlChange: retainWebsiteNavigation });
  const handledRequest = React.useRef(0);
  React.useEffect(() => {
    if (visible && !hasOpened) {
      if (!request || request.action === 'home') handledRequest.current = request?.sequence ?? 0;
      setHasOpened(true);
    }
  }, [visible, hasOpened, request]);

  React.useEffect(() => {
    if (navigation.status.kind === 'ready') useClaudeStore.getState().adoptPageTitle(navigation.url, navigation.title);
    else useClaudeStore.getState().adoptPageTitle('', '');
  }, [navigation.url, navigation.title, navigation.status.kind]);

  React.useEffect(() => {
    if (!webview || !visible || !request || request.sequence === handledRequest.current || navigation.status.kind === 'loading' || navigation.status.kind === 'idle') return;
    handledRequest.current = request.sequence;
    if (request.action === 'refresh') webview.reload();
    else void webview.loadURL(request.action === 'home' ? CLAUDE_URL : request.action.url);
  }, [webview, visible, request, navigation.status.kind]);

  if (!visible && !hasOpened) return null;
  return <section className={visible ? 'absolute inset-0 z-10 flex flex-col bg-background' : 'hidden'} aria-label="Claude" aria-hidden={!visible || undefined}>
    <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
      {headerTabsEnabled ? <div className="min-w-0 flex-1" /> : <div className="min-w-0 flex-1" role="tablist" aria-label="Claude">
        <Button id="claude-website-tab" size="xs" variant="secondary" role="tab" aria-selected="true" aria-controls="claude-website-panel" className="max-w-full gap-1.5" onClick={() => webview?.focus()}>
          <ClaudeLogo className="size-3.5" /><span className="truncate">{pageTitle || 'Claude'}</span>
        </Button>
      </div>}
      <Button size="xs" variant="ghost" disabled={!navigation.canGoBack} aria-label={t('contextPanel.browser.back')} onClick={() => webview?.goBack()}><Icon name="arrow-left" className="size-3.5" /></Button>
      <Button size="xs" variant="ghost" disabled={!navigation.canGoForward} aria-label={t('contextPanel.browser.forward')} onClick={() => webview?.goForward()}><Icon name="arrow-right" className="size-3.5" /></Button>
      <Button size="xs" variant="ghost" onClick={() => webview?.focus()}>{t('claude.full')}</Button>
      <Button size="xs" variant="ghost" disabled={!pageUrl} aria-pressed={saved} aria-label={t(saved ? 'claude.unpin' : 'claude.pin')} title={t(saved ? 'claude.unpin' : 'claude.pin')} onClick={() => useClaudeStore.getState().toggleSavedPage()}><Icon name="pushpin" className="size-3.5" /></Button>
      <Button size="xs" variant="ghost" aria-label={t('contextPanel.browser.reload')} onClick={() => webview?.reload()}><Icon name="refresh" className="size-3.5" /></Button>
    </div>
    <p className="shrink-0 border-b border-border px-3 py-1 typography-meta text-muted-foreground">{t('claude.historyUnavailable')}</p>
    <div id="claude-website-panel" role={headerTabsEnabled ? undefined : 'tabpanel'} aria-labelledby={headerTabsEnabled ? undefined : 'claude-website-tab'} className="relative min-h-0 flex-1">
      <webview ref={attachWebview} src={CLAUDE_URL} partition={CLAUDE_PARTITION} style={{ width: '100%', height: '100%', border: 'none' }} />
      {navigation.status.kind === 'failed' && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6">
        <p>{t('contextPanel.browser.loadFailed')}</p>
        <Button variant="outline" onClick={() => webview?.reload()}>{t('contextPanel.browser.reload')}</Button>
      </div>}
    </div>
  </section>;
}

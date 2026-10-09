import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useWebviewNavigation } from '@/components/browser/useWebviewNavigation';
import { useChatGPTStore } from '@/stores/useChatGPTStore';
import { buildWebsiteScript, isChatGPTOrigin, websiteSnapshotSchema } from '@/lib/chatgpt/website';

const CHATGPT_URL = 'https://chatgpt.com/';
const retainWebsiteNavigation = () => {};

/** Only navigation metadata crosses out of the isolated ChatGPT website. */
export function ChatGPTWorkspace({ visible }: { visible: boolean }): React.ReactNode {
  const { t } = useI18n();
  const [hasOpened, setHasOpened] = React.useState(false);
  const [webview, setWebview] = React.useState<WebviewElement | null>(null);
  const attachWebview = React.useCallback((node: WebviewElement | null) => setWebview(node), []);
  const mode = useChatGPTStore(s => s.mode);
  const request = useChatGPTStore(s => s.request);
  const tabs = useChatGPTStore(s => s.openedPaths);
  const active = useChatGPTStore(s => s.activePath);
  const chats = useChatGPTStore(s => s.chats);
  const status = useChatGPTStore(s => s.status);
  const navigation = useWebviewNavigation(webview, { initialUrl: CHATGPT_URL, onUrlChange: retainWebsiteNavigation });
  const handledRequest = React.useRef(0);
  React.useEffect(() => { if (visible) setHasOpened(true); }, [visible]);

  React.useEffect(() => {
    // A menu must not pin the previous conversation while a new page loads.
    if (navigation.status.kind !== 'ready') useChatGPTStore.getState().markUnavailable();
  }, [navigation.status.kind]);

  React.useEffect(() => {
    if (!webview || !visible) return;
    let alive = true;
    let reading = false;
    const read = async () => {
      if (reading || !alive || navigation.status.kind !== 'ready') return;
      reading = true;
      try {
        const pageUrl = webview.getURL();
        if (!pageUrl || pageUrl === 'about:blank') return;
        if (!isChatGPTOrigin(pageUrl)) {
          if (alive) useChatGPTStore.getState().clearAccount();
          return;
        }
        const raw = await webview.executeJavaScript(buildWebsiteScript({ kind: 'snapshot', integrated: mode === 'integrated' }), false);
        const parsed = websiteSnapshotSchema.safeParse(raw);
        if (!alive || webview.getURL() !== pageUrl) return;
        if (parsed.success) useChatGPTStore.getState().adoptSnapshot(parsed.data);
        else useChatGPTStore.getState().markUnavailable();
      } catch { if (alive) useChatGPTStore.getState().markUnavailable(); }
      finally { reading = false; }
    };
    const onNavigation = () => { void read(); };
    webview.addEventListener('dom-ready', onNavigation);
    webview.addEventListener('did-navigate-in-page', onNavigation);
    webview.addEventListener('did-stop-loading', onNavigation);
    const timer = setInterval(onNavigation, 3000);
    void read();
    return () => {
      alive = false; clearInterval(timer);
      webview.removeEventListener('dom-ready', onNavigation);
      webview.removeEventListener('did-navigate-in-page', onNavigation);
      webview.removeEventListener('did-stop-loading', onNavigation);
    };
  }, [webview, visible, mode, navigation.status.kind]);

  React.useEffect(() => {
    if (!webview || !visible || !request || request.sequence === handledRequest.current) return;
    // Guests cannot accept loadURL before attachment. dom-ready triggers navigation.status.
    if (navigation.status.kind !== 'ready') return;
    handledRequest.current = request.sequence;
    const action = request.action;
    if (action.kind === 'navigate') {
      const load = () => { if (useChatGPTStore.getState().request?.sequence === request.sequence) webview.loadURL(`${CHATGPT_URL.slice(0, -1)}${action.path}`); };
      if (!isChatGPTOrigin(webview.getURL())) { load(); return; }
      void webview.executeJavaScript(buildWebsiteScript(action), true).then(result => { if (result !== true) load(); }).catch(load);
      return;
    }
    if (action.kind === 'refresh') { webview.reload(); return; }
    if (!isChatGPTOrigin(webview.getURL())) return;
    // Library can ignore synthetic clicks; use its verified public route.
    if (action.kind === 'shortcut' && action.label === 'Library') {
      webview.loadURL('https://chatgpt.com/library');
      return;
    }
    void webview.executeJavaScript(buildWebsiteScript(action), true).then((result) => {
      if (result !== true) useChatGPTStore.getState().setMode('full');
    }).catch(() => useChatGPTStore.getState().setMode('full'));
  }, [webview, visible, request, navigation.status]);

  if (!visible && !hasOpened) return null;
  return <section className={visible ? 'absolute inset-0 z-10 flex flex-col bg-background' : 'hidden'} aria-label="ChatGPT" aria-hidden={!visible || undefined}>
    <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map(path => <div key={path} className="flex shrink-0 items-center rounded-md">
          <Button size="xs" variant={active === path ? 'secondary' : 'ghost'} className="max-w-52" onClick={() => useChatGPTStore.getState().open({ kind: 'navigate', path })}>
            <span className="truncate">{chats.find(chat => chat.path === path)?.title || t('chatgpt.chat')}</span>
          </Button>
          <Button size="xs" variant="ghost" aria-label={t('gitView.common.close')} onClick={() => useChatGPTStore.getState().closeTab(path)}><Icon name="close" className="size-3" /></Button>
        </div>)}
      </div>
      <Button size="xs" variant="ghost" onClick={() => useChatGPTStore.getState().open({ kind: 'navigate', path: '/' })}><Icon name="add" className="size-3.5" />{t('chatgpt.new')}</Button>
      <Button size="xs" variant="ghost" aria-pressed={mode === 'full'} onClick={() => useChatGPTStore.getState().setMode(mode === 'full' ? 'integrated' : 'full')}>
        <Icon name="layout-left" className="size-3.5" />{t(mode === 'full' ? 'chatgpt.integrated' : 'chatgpt.full')}
      </Button>
    </div>
    {status === 'unavailable' && <div className="flex shrink-0 items-center gap-2 px-3 py-1 text-xs text-muted-foreground" role="status">
      <span className="flex-1">{t('chatgpt.unavailable')}</span>
      <Button size="xs" variant="ghost" onClick={() => useChatGPTStore.getState().setMode('full')}>{t('chatgpt.full')}</Button>
    </div>}
    <div className="relative min-h-0 flex-1">
      <webview ref={attachWebview} src={CHATGPT_URL} partition="persist:openchamber-browser" allowpopups style={{ width: '100%', height: '100%', border: 'none' }} />
      {navigation.status.kind === 'failed' && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6">
        <p>{t('contextPanel.browser.loadFailed')}</p>
        <Button variant="outline" onClick={() => webview?.reload()}>{t('contextPanel.browser.reload')}</Button>
      </div>}
    </div>
  </section>;
}

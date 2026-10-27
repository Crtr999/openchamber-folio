import React from 'react';
import { z } from 'zod';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { MAX_EXPORT_BYTES, retainedConversationSchema, type RetainedConversation } from '@/lib/chatgpt/export';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { isDesktopLocalOriginActive, isElectronShell } from '@/lib/desktop';
import { opencodeClient } from '@/lib/opencode/client';
import { ascendingId } from '@/lib/opencode/ids';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';

const resultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), conversations: z.array(retainedConversationSchema), skipped: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('error'), code: z.string() }),
]);

/** Explicit file import. No website cookies, credentials, or model calls. */
export function ChatGPTImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const [conversations, setConversations] = React.useState<RetainedConversation[]>([]);
  const [skipped, setSkipped] = React.useState(0);
  const [query, setQuery] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const worker = React.useRef<Worker | null>(null);
  const generation = React.useRef(0);
  const retaining = React.useRef(false);
  const pending = React.useRef<{ sourceId: string; runtime: string; directory: string; sessionID: string; messageID: string } | null>(null);
  React.useEffect(() => {
    if (!open) {
      generation.current += 1;
      worker.current?.terminate(); worker.current = null;
      setConversations([]); setQuery(''); setSkipped(0); setFailed(false); setBusy(false);
    }
    return () => { generation.current += 1; worker.current?.terminate(); worker.current = null; };
  }, [open]);

  const load = async (file: File) => {
    const revision = ++generation.current;
    worker.current?.terminate();
    setConversations([]); setSkipped(0); setFailed(false); setBusy(true); pending.current = null;
    if (file.size > MAX_EXPORT_BYTES) { setFailed(true); setBusy(false); return; }
    try {
      const bytes = await file.arrayBuffer();
      if (generation.current !== revision) return;
      const reader = new Worker(new URL('../../lib/chatgpt/export.worker.ts', import.meta.url), { type: 'module' });
      worker.current = reader;
      reader.onmessage = (event: MessageEvent<unknown>) => {
        if (generation.current !== revision) return;
        const result = resultSchema.safeParse(event.data);
        if (result.success && result.data.kind === 'ready') {
          setConversations(result.data.conversations); setSkipped(result.data.skipped);
        } else setFailed(true);
        setBusy(false); reader.terminate(); worker.current = null;
      };
      reader.onerror = () => {
        if (generation.current === revision) { setFailed(true); setBusy(false); }
        reader.terminate();
      };
      reader.postMessage({ bytes, zip: file.name.toLowerCase().endsWith('.zip') }, [bytes]);
    } catch { if (generation.current === revision) { setFailed(true); setBusy(false); } }
  };

  const retain = async (conversation: RetainedConversation) => {
    if (busy || retaining.current || !isElectronShell() || !isDesktopLocalOriginActive()) return;
    retaining.current = true;
    setBusy(true); setFailed(false);
    const runtime = getRuntimeKey();
    const sdk = opencodeClient.getSdkClient();
    const revision = generation.current;
    const current = () => getRuntimeKey() === runtime && opencodeClient.getSdkClient() === sdk
      && generation.current === revision && isDesktopLocalOriginActive()
      && useConfigStore.getState().currentAgentName?.toLowerCase() !== 'zdr';
    try {
      if (!current()) throw new Error('Import unavailable');
      const { home } = await opencodeClient.getFilesystemHomeInfo();
      if (!current() || !home) throw new Error('Import unavailable');
      const directory = `${home.replace(/\/$/, '')}/Documents/Open Carter/ChatGPT`;
      const catalog = await opencodeClient.getProvidersForConfig(directory);
      if (!current()) return;
      const provider = catalog.providers.find(item => item.id === 'openai' && item.activation !== 'disabled');
      const model = provider && catalog.models.find(item => item.providerID === provider.id && item.enabled);
      if (!model) throw new Error('OpenAI connection required');
      const projects = useProjectsStore.getState();
      if (!projects.projects.some(item => item.path === directory)) await projects.addProject(directory, { label: 'ChatGPT' });
      if (!current()) return;
      let attempt = pending.current;
      if (!attempt || attempt.sourceId !== conversation.sourceId || attempt.runtime !== runtime || attempt.directory !== directory) {
        const session = await opencodeClient.createSession({
          title: conversation.title, agent: 'ChatGPT', model: { providerID: 'openai', id: model.id },
          metadata: { chatgptImport: { sourceId: conversation.sourceId, omittedAttachments: conversation.omittedAttachments, importedAt: new Date().toISOString() } },
        }, directory);
        attempt = { sourceId: conversation.sourceId, runtime, directory, sessionID: session.id, messageID: ascendingId('msg') };
        pending.current = attempt;
      }
      if (!current()) return;
      await opencodeClient.retainImportedContext({ ...attempt, runtimeKey: runtime, text: conversation.text, description: conversation.title });
      if (!current()) return;
      pending.current = null;
      useSessionUIStore.getState().setCurrentSession(attempt.sessionID, directory);
      useUIStore.getState().closeMainSurfaces();
      onOpenChange(false);
    } catch { if (current()) setFailed(true); }
    finally { retaining.current = false; if (generation.current === revision) setBusy(false); }
  };

  const matches = conversations.filter(item => item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}>
    <DialogContent>
      <DialogHeader><DialogTitle>{t('chatgpt.import')}</DialogTitle><DialogDescription>{t('chatgpt.importHelp')}</DialogDescription></DialogHeader>
      <p className="text-sm text-muted-foreground">{t('chatgpt.importNotice')}</p>
      <Input type="file" accept=".zip,.json" disabled={busy} aria-label={t('chatgpt.importFile')} onChange={event => { const file = event.target.files?.[0]; if (file) void load(file); event.target.value = ''; }} />
      {busy && <p role="status">{t('common.loading')}</p>}
      {failed && <p role="alert">{t('chatgpt.importFailed')}</p>}
      {skipped > 0 && <p role="status">{t('chatgpt.importSkipped', { count: skipped })}</p>}
      {conversations.length > 0 && <>
        <Input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('chatgpt.importSearch')} aria-label={t('chatgpt.importSearch')} />
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {matches.slice(0, 50).map((item, index) => <Button key={`${item.sourceId}-${index}`} variant="ghost" className="w-full justify-start" disabled={busy} onClick={() => void retain(item)}>
            <span className="truncate">{item.title}</span>{item.omittedAttachments > 0 && <span className="shrink-0 text-xs text-muted-foreground">{t('chatgpt.importPartial')}</span>}
          </Button>)}
        </div>
      </>}
    </DialogContent>
  </Dialog>;
}

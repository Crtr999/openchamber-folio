import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { createChatDirectory } from '@/lib/chatDirectories';
import { useFolioStore } from '@/lib/folio/store';
import type { FolioNote } from '@/lib/folio/schema';
import type { Message, Part, PermissionRequest } from '@/lib/opencode/model';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { createSession, respondToPermission } from '@/sync/session-actions';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useEnsureSessionMessages, useSessionMessages, useSessionPartsForMessages, useSessionPermissions, useSessionStatus } from '@/sync/sync-context';

/** The conversation each page has with the AI, remembered on this Mac. */
interface PageChat { sessionId: string; directory: string; sentModified?: number }
const storageKey = 'folio.ask.v1';
const readChats = (): Record<string, PageChat> => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const chats: Record<string, PageChat> = {};
    for (const [noteID, value] of Object.entries(parsed)) {
      if (value && typeof value === 'object' && 'sessionId' in value && 'directory' in value && typeof value.sessionId === 'string' && typeof value.directory === 'string') {
        chats[noteID] = { sessionId: value.sessionId, directory: value.directory, sentModified: 'sentModified' in value && typeof value.sentModified === 'number' ? value.sentModified : undefined };
      }
    }
    return chats;
  } catch { return {}; }
};
const writeChats = (chats: Record<string, PageChat>) => { try { localStorage.setItem(storageKey, JSON.stringify(chats)); } catch { /* storage blocked */ } };

const suggestionKeys = ['folio.askSummarize', 'folio.askOutline', 'folio.askQuiz', 'folio.askActions'] as const;

/**
 * Ask AI about the open page, like Notion's AI panel. It is an ordinary OpenChamber chat (your
 * models, agents and keys; it also appears under Chats) that starts knowing the page, and uses the
 * `folio` tool to read other pages you @mention and to change your notes and databases directly.
 */
export function FolioAskPanel({ note, onClose }: { note: FolioNote; onClose: () => void }) {
  const { t } = useI18n();
  const [chats, setChats] = React.useState(readChats);
  const chat = chats[note.id];
  const [draft, setDraft] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => { setError(undefined); inputRef.current?.focus(); }, [note.id]);

  const remember = (next: Record<string, PageChat>) => { writeChats(next); setChats(next); };

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || sending) return;
    const config = useConfigStore.getState();
    const providerID = config.currentProviderId, modelID = config.currentModelId;
    if (!providerID || !modelID) { setError(t('folio.askNoModel')); return; }
    setSending(true); setError(undefined);
    try {
      // The page is sent as it is on screen, so unsaved typing is saved first.
      await useFolioStore.getState().flush();
      const page = useFolioStore.getState().status?.notes.find((n) => n.id === note.id) ?? note;
      let current = readChats()[note.id];
      if (!current) {
        const directory = await createChatDirectory();
        const session = await createSession(page.title || t('folio.untitled'), directory, undefined, undefined,
          { model: { providerID, id: modelID, ...(config.currentVariant ? { variant: config.currentVariant } : {}) }, agent: config.currentAgentName }, 'preserve');
        if (!session) throw new Error(t('folio.askFailed'));
        current = { sessionId: session.id, directory: session.directory || directory };
      }
      // The whole page goes along the first time and whenever it changed since; otherwise just which page it is.
      let context = `The user is asking from their Folio notebook page "${page.title || 'Untitled'}" (page id ${page.id}). Use the folio tool to read pages they @mention and to make any change to their notes or databases; edits appear on their screen immediately.`;
      if (page.excludedFromAI) context += ' This page is excluded from AI, so its content is not shared.';
      else if (current.sentModified !== page.modified) {
        const response = await useFolioStore.getState().api?.request({ command: 'markdown', noteID: page.id, flag: true });
        if (response?.ok && response.text) context += `\n\nCurrent page content:\n\n${response.text}`;
      }
      await useSessionUIStore.getState().sendMessage(question, providerID, modelID, config.currentAgentName, undefined, undefined,
        [{ text: context, synthetic: true }], config.currentVariant, 'normal', { sessionId: current.sessionId, directory: current.directory });
      remember({ ...readChats(), [note.id]: { ...current, sentModified: page.modified } });
      setDraft('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setSending(false); }
  };
  const newChat = () => { const next = { ...readChats() }; delete next[note.id]; remember(next); setDraft(''); inputRef.current?.focus(); };
  const openInChat = () => {
    if (!chat) return;
    void useFolioStore.getState().close();
    useUIStore.getState().closeMainSurfaces();
    void useSessionUIStore.getState().setCurrentSession(chat.sessionId, chat.directory);
  };

  return <aside className="flex w-[380px] shrink-0 flex-col border-l border-border bg-background" aria-label={t('folio.askTitle')}>
    <header className="flex h-11 shrink-0 items-center gap-1 px-3">
      <Icon name="sparkling" className="size-4 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{t('folio.askTitle')}</span>
      {chat && <button type="button" className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground" title={t('folio.askOpenInChat')} aria-label={t('folio.askOpenInChat')} onClick={openInChat}><Icon name="chat-3" className="size-4" /></button>}
      {chat && <button type="button" className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground" title={t('folio.newChat')} aria-label={t('folio.newChat')} onClick={newChat}><Icon name="chat-new" className="size-4" /></button>}
      <button type="button" className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground" title={t('folio.close')} aria-label={t('folio.close')} onClick={onClose}><Icon name="close" className="size-4" /></button>
    </header>
    {chat
      ? <Conversation key={chat.sessionId} chat={chat} />
      : <div className="flex min-h-0 flex-1 flex-col justify-end gap-1 px-4 pb-3">
        <p className="mb-2 text-[15px] font-semibold">{t('folio.askHello', { title: note.title || t('folio.untitled') })}</p>
        {suggestionKeys.map((key) => <button key={key} type="button" disabled={sending || note.excludedFromAI} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-interactive-hover disabled:opacity-50" onClick={() => void send(t(key))}>
          <Icon name="sparkling" className="size-4 shrink-0 text-muted-foreground" />{t(key)}
        </button>)}
      </div>}
    {error && <p role="alert" className="mx-3 mb-2 rounded-md bg-[color-mix(in_srgb,var(--status-error)_12%,transparent)] px-2 py-1.5 text-xs">{error}</p>}
    <form className="m-3 mt-0 rounded-xl border border-border bg-background p-2 focus-within:border-foreground/30" onSubmit={(e) => { e.preventDefault(); void send(draft); }}>
      <textarea ref={inputRef} rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('folio.askPlaceholder')} aria-label={t('folio.askPlaceholder')}
        className="block max-h-48 w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(draft); } }} />
      <div className="flex items-center justify-end">
        <button type="submit" disabled={!draft.trim() || sending} className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40" aria-label={t('folio.send')}><Icon name="arrow-up" className="size-4" /></button>
      </div>
    </form>
  </aside>;
}

function textOf(parts: readonly Part[] | undefined): string {
  return (parts ?? []).flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n\n').trim();
}

/** What a tool step did, in a few words ("Read a note", "Add a database row"). */
function toolLabel(part: Extract<Part, { type: 'tool' }>): string {
  const meta = part.state.status === 'pending' ? undefined : part.state.metadata?.openchamber;
  if (meta && typeof meta === 'object' && !Array.isArray(meta) && typeof meta.description === 'string') return meta.description;
  return part.tool;
}

function Conversation({ chat }: { chat: PageChat }) {
  const { t } = useI18n();
  useEnsureSessionMessages(chat.sessionId, chat.directory);
  const messages = useSessionMessages(chat.sessionId, chat.directory);
  const visible = React.useMemo(() => messages.filter((m): m is Extract<Message, { role: 'user' | 'assistant' }> => m.role === 'user' || m.role === 'assistant'), [messages]);
  const ids = React.useMemo(() => visible.map((m) => m.id), [visible]);
  const parts = useSessionPartsForMessages(ids, chat.directory);
  const status = useSessionStatus(chat.sessionId, chat.directory);
  const permissions = useSessionPermissions(chat.sessionId, chat.directory);
  const busy = Boolean(status && status.type !== 'idle');
  const end = React.useRef<HTMLDivElement>(null);
  const lastText = textOf(parts[ids.at(-1) ?? '']);
  React.useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [ids.length, lastText.length, permissions.length]);

  return <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
    {visible.map((message) => {
      const messageParts = parts[message.id] ?? [];
      if (message.role === 'user') {
        const text = textOf(messageParts);
        return text ? <div key={message.id} className="mb-3 ml-8 whitespace-pre-wrap rounded-xl bg-secondary px-3 py-2 text-sm">{text}</div> : null;
      }
      return <div key={message.id} className="mb-3 text-sm">
        {messageParts.map((part) => {
          if (part.type === 'text' && part.text.trim()) return <SimpleMarkdownRenderer key={part.id} content={part.text} />;
          if (part.type === 'tool') return <div key={part.id} className="my-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Icon name={part.state.status === 'error' ? 'error-warning' : part.state.status === 'completed' ? 'check' : 'loader-4'} className={cn('size-3.5', (part.state.status === 'running' || part.state.status === 'pending') && 'animate-spin')} />
            {toolLabel(part)}
          </div>;
          return null;
        })}
        {message.error && <p className="text-xs text-[var(--status-error)]">{t('folio.askFailed')}</p>}
      </div>;
    })}
    {permissions.map((request) => <PermissionCard key={request.id} request={request} chat={chat} />)}
    {busy && <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground"><Icon name="loader-4" className="size-3.5 animate-spin" />{t('folio.askThinking')}</div>}
    <div ref={end} />
  </div>;
}

/** The AI asked to do something that needs your OK (for example run a command). */
function PermissionCard({ request, chat }: { request: PermissionRequest; chat: PageChat }) {
  const { t } = useI18n();
  const reply = (answer: 'once' | 'reject') => { void respondToPermission(chat.sessionId, request.id, answer, chat.directory).catch(() => undefined); };
  return <div className="mb-3 rounded-lg border border-border p-2.5 text-sm">
    <p className="mb-2">{request.message || t('folio.askPermission', { action: request.action })}</p>
    {request.resources.length > 0 && <p className="mb-2 truncate font-mono text-xs text-muted-foreground">{request.resources.join(', ')}</p>}
    <div className="flex gap-2">
      <button type="button" className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground" onClick={() => reply('once')}>{t('folio.askAllow')}</button>
      <button type="button" className="rounded-md bg-secondary px-2.5 py-1 text-xs" onClick={() => reply('reject')}>{t('folio.askDeny')}</button>
    </div>
  </div>;
}

import React from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { Icon } from '@/components/icon/Icon';
import { FolioIcon } from '@/components/folio/FolioIcon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useFolioStore } from '@/lib/folio/store';
import { noteToMarkdown } from '@/lib/folio/local-engine';
import { chatProviders, defaultModels, sendChat, type ChatMessage, type ChatModel } from '@/lib/folio/mobile-chat';
import { newChat, readKey, useMobileChatStore, type MobileChat } from './chatStore';
import { nativePost } from './host';

function Markdown({ text }: { text: string }) {
  const html = React.useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true })), [text]);
  return <div className="folio-mobile-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

const modelKey = (m: ChatModel) => `${m.provider}:${m.id}`;

/** Chat that runs straight from the phone to the AI provider, with notes attached as context. */
export function FolioMobileChat({ onMenu }: { onMenu: () => void }) {
  const { t } = useI18n();
  const notes = useFolioStore((s) => s.status?.notes);
  const { chats, activeID, model, extraModels, save, setModel, open, macChat } = useMobileChatStore();
  const chat = chats.find((c) => c.id === activeID);
  const [draft, setDraft] = React.useState('');
  const [attached, setAttached] = React.useState<string[]>([]);
  const [streaming, setStreaming] = React.useState<string>();
  const [error, setError] = React.useState('');
  const [mention, setMention] = React.useState<string>();
  const abort = React.useRef<AbortController>(undefined);
  const scroller = React.useRef<HTMLDivElement>(null);
  const models = React.useMemo(() => [...defaultModels, ...extraModels.filter((m) => !defaultModels.some((d) => modelKey(d) === modelKey(m)))], [extraModels]);
  const current = chat?.model ?? model;
  const noteIDs = chat ? [...new Set([...chat.noteIDs, ...attached])] : attached;
  const liveNotes = (notes ?? []).filter((n) => !n.trashed);

  React.useEffect(() => { setAttached([]); setError(''); }, [activeID]);
  const pendingPrompt = useMobileChatStore((s) => s.pendingPrompt);
  const pendingNoteID = useMobileChatStore((s) => s.pendingNoteID);
  React.useEffect(() => {
    if (pendingPrompt) setDraft(pendingPrompt);
    if (pendingNoteID) setAttached([pendingNoteID]);
    if (pendingPrompt || pendingNoteID) useMobileChatStore.setState({ pendingPrompt: undefined, pendingNoteID: undefined });
  }, [pendingPrompt, pendingNoteID]);
  React.useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [chat?.messages.length, streaming]);

  const mentionMatches = mention === undefined ? [] : liveNotes.filter((n) => (n.title || t('folio.untitled')).toLowerCase().includes(mention.toLowerCase())).slice(0, 6);

  const send = async () => {
    const text = draft.trim();
    if (!text || streaming !== undefined) return;
    const base: MobileChat = chat ?? newChat(current);
    const userMessage: ChatMessage = { role: 'user', content: text };
    const context = noteIDs.flatMap((id) => { const note = liveNotes.find((n) => n.id === id); return note && !note.excludedFromAI ? [noteToMarkdown(note)] : []; });
    const system: ChatMessage[] = context.length ? [{ role: 'system', content: `The user attached these notes from Folio:\n\n${context.join('\n\n---\n\n')}` }] : [];
    const withUser: MobileChat = { ...base, noteIDs, title: base.title || text.slice(0, 60), messages: [...base.messages, userMessage], modified: Date.now() };
    await save(withUser); open(withUser.id);
    setDraft(''); setAttached([]); setError(''); setStreaming('');
    const controller = new AbortController(); abort.current = controller;
    let reply = '';
    try {
      await sendChat({
        model: withUser.model, key: await readKey(withUser.model.provider), signal: controller.signal, nativePost,
        messages: [...system, ...withUser.messages],
        onText: (piece) => { reply += piece; setStreaming(reply); },
      });
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (reply) await save({ ...withUser, messages: [...withUser.messages, { role: 'assistant', content: reply }], modified: Date.now() });
      setStreaming(undefined); abort.current = undefined;
    }
  };

  const changeModel = (key: string) => {
    const next = models.find((m) => modelKey(m) === key); if (!next) return;
    setModel(next);
    if (chat) void save({ ...chat, model: next });
  };

  return <div className="flex h-full flex-col bg-background text-foreground">
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border/60 px-2">
      <button type="button" className="flex size-9 items-center justify-center rounded-md text-muted-foreground" aria-label={t('folio.menu')} onClick={onMenu}><Icon name="menu-2" className="size-5" /></button>
      <select className="min-w-0 flex-1 truncate rounded-md bg-transparent px-1 py-1 text-sm font-medium" aria-label={t('folio.model')} value={modelKey(current)} onChange={(e) => changeModel(e.target.value)}>
        {chatProviders.map((provider) => <optgroup key={provider.id} label={provider.name}>
          {models.filter((m) => m.provider === provider.id).map((m) => <option key={modelKey(m)} value={modelKey(m)}>{m.name}</option>)}
        </optgroup>)}
      </select>
      <button type="button" className="flex size-9 items-center justify-center rounded-md text-muted-foreground" aria-label={t('folio.newChat')} onClick={() => open(undefined)}><Icon name="chat-new" className="size-5" /></button>
    </header>

    {macChat ? <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground"><Icon name="computer" className="size-4" /><span className="truncate">{macChat.title}</span></div>
      {!macChat.messages && !macChat.error && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Icon name="loader-4" className="size-4 animate-spin" />{t('folio.loadingChat')}</div>}
      {macChat.error && <div role="alert" className="rounded-lg bg-[color-mix(in_srgb,var(--status-error)_12%,transparent)] px-3 py-2 text-sm">{macChat.error}</div>}
      {macChat.messages?.map((message, i) => <div key={i} className={cn('mb-4', message.role === 'user' && 'flex justify-end')}>
        {message.role === 'user' ? <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-secondary px-3.5 py-2 text-[15px]">{message.content}</div> : <Markdown text={message.content} />}
      </div>)}
    </div> : <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      {!chat?.messages.length && streaming === undefined && <div className="mt-16 text-center text-sm text-muted-foreground">
        <Icon name="sparkling" className="mx-auto mb-3 size-7 text-primary" />
        <p>{t('folio.chatEmpty')}</p>
      </div>}
      {chat?.messages.map((message, i) => <div key={i} className={cn('mb-4', message.role === 'user' && 'flex justify-end')}>
        {message.role === 'user'
          ? <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-secondary px-3.5 py-2 text-[15px]">{message.content}</div>
          : <Markdown text={message.content} />}
      </div>)}
      {streaming !== undefined && <div className="mb-4">{streaming ? <Markdown text={streaming} /> : <Icon name="loader-4" className="size-4 animate-spin text-muted-foreground" />}</div>}
      {error && <div role="alert" className="mb-4 rounded-lg bg-[color-mix(in_srgb,var(--status-error)_12%,transparent)] px-3 py-2 text-sm">{error}</div>}
    </div>}

    {macChat ? <div className="shrink-0 border-t border-border/60 px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-2">
      <button type="button" className="w-full rounded-2xl bg-primary px-3 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-40" disabled={!macChat.messages?.length}
        onClick={() => { const seeded: MobileChat = { ...newChat(current), title: macChat.title, messages: macChat.messages ?? [] }; void save(seeded).then(() => open(seeded.id)); }}>
        {t('folio.continueOnPhone')}
      </button>
    </div> : <div className="shrink-0 border-t border-border/60 px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-2">
      {noteIDs.length > 0 && <div className="mb-2 flex flex-wrap gap-1.5">{noteIDs.map((id) => { const note = liveNotes.find((n) => n.id === id); return note ? <span key={id} className="flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs">
        <FolioIcon value={note.icon} />{note.title || t('folio.untitled')}
        {attached.includes(id) && <button type="button" aria-label={t('folio.remove')} onClick={() => setAttached(attached.filter((a) => a !== id))}>×</button>}
      </span> : null; })}</div>}
      {mentionMatches.length > 0 && <div role="listbox" className="mb-2 overflow-hidden rounded-xl border border-border bg-background shadow-lg">
        {mentionMatches.map((note) => <button key={note.id} type="button" role="option" aria-selected={false} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm active:bg-interactive-selection"
          onClick={() => { setAttached([...new Set([...attached, note.id])]); setDraft(draft.replace(/@[^\s@]*$/, '')); setMention(undefined); }}>
          <FolioIcon value={note.icon} /><span className="truncate">{note.title || t('folio.untitled')}</span>
        </button>)}
      </div>}
      <div className="flex items-end gap-2">
        <textarea rows={1} className="max-h-40 min-h-[40px] flex-1 resize-none rounded-2xl border border-border bg-background px-3.5 py-2 text-[16px] outline-none" placeholder={t('folio.chatPlaceholder')} aria-label={t('folio.chatPlaceholder')}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${e.target.scrollHeight}px`; const m = /@([^\s@]*)$/.exec(e.target.value); setMention(m ? m[1] : undefined); }} />
        {streaming !== undefined
          ? <button type="button" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-foreground text-background" aria-label={t('folio.stop')} onClick={() => abort.current?.abort()}><Icon name="stop" className="size-4" /></button>
          : <button type="button" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40" aria-label={t('folio.send')} disabled={!draft.trim()} onClick={() => void send()}><Icon name="arrow-up" className="size-5" /></button>}
      </div>
    </div>}
  </div>;
}

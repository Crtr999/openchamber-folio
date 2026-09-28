import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { handleDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { createChatDirectory } from '@/lib/chatDirectories';
import { buildSkillMentionInstruction } from '@/lib/skillMentionInstruction';
import { useFolioStore } from '@/lib/folio/store';
import type { FolioNote } from '@/lib/folio/schema';
import { FOLIO_ASK_AGENT, FOLIO_ASK_PERMISSIONS } from '@/lib/folio/ask-agent';
import { readPageChats, useFolioAskModelStore, writePageChats, type PageChat } from '@/lib/folio/ask';
import { askModelRef, resolveAskModel, type AskModelSelection } from '@/lib/folio/ask-model';
import { askComposerAction, askMentionChats, collectAskMentions, flattenAskMentions, nextAskMentionIndex, type AskMention } from '@/lib/folio/ask-mentions';
import { FolioIcon } from './FolioIcon';
import { FolioAskModelPicker } from './FolioAskModelPicker';
import type { Message, Part, PermissionRequest, Session } from '@/lib/opencode/model';
import { opencodeClient, type SkillMentions } from '@/lib/opencode/client';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { selectSkillsForDirectory, useSkillsStore } from '@/stores/useSkillsStore';
import { useUIStore } from '@/stores/useUIStore';
import { createSession, respondToPermission } from '@/sync/session-actions';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useEnsureSessionMessages, useSessionMessages, useSessionPartsForMessages, useSessionPermissions, useSessionStatus } from '@/sync/sync-context';

const suggestionKeys = ['folio.askSummarize', 'folio.askOutline', 'folio.askQuiz', 'folio.askActions'] as const;

/** What each group of results is called, keyed by the group the picker draws. */
const groupKeys = { page: 'folio.askGroupPages', chat: 'folio.askGroupChats', file: 'folio.askGroupFiles', skill: 'folio.askGroupSkills' } as const;

const mentionIcon = { page: 'article', chat: 'chat-3', file: 'attachment-2', skill: 'tools' } as const;

/** Where a send goes, plus the skills this panel can attach to it. */
interface AskSendOptions { sessionId: string; directory: string; skills?: SkillMentions }

/**
 * Ask AI about the open page, like Notion's AI panel. It is an OpenChamber chat on your
 * models and keys (it also appears under Chats), on Folio's own notebook agent rather
 * than whichever agent the chat beside you is on, so it answers from the page instead
 * of going looking for the source. It uses the `folio` tool to read other pages you
 * @mention and to change your notes and databases directly.
 */
export function FolioAskPanel({ note, onClose }: { note: FolioNote; onClose: () => void }) {
  const { t } = useI18n();
  const [chats, setChats] = React.useState(readPageChats);
  const chat = chats[note.id];
  const [draft, setDraft] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [mentions, setMentions] = React.useState<AskMention[]>([]);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => { setError(undefined); inputRef.current?.focus(); }, [note.id]);
  // "@" points at a page, a chat, a file or a skill: a list of groups narrows as you type.
  const [picker, setPicker] = React.useState<{ query: string; start: number }>();
  const [pickIndex, setPickIndex] = React.useState(0);
  const notes = useFolioStore((s) => s.status?.notes);
  const [allSessions, setAllSessions] = React.useState<readonly Session[]>([]);
  React.useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const page = await opencodeClient.listSessionsPage({ global: true, limit: 500 });
        if (mounted) setAllSessions(page.sessions);
      } catch { /* OpenCode may not be available */ }
    };
    load();
    const interval = setInterval(load, 45_000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  // The global store as a fallback.
  const storeSessions = useGlobalSessionsStore((s) => s.activeSessions);
  const sessions = allSessions.length > 0 ? allSessions : storeSessions;
  const askSelection = useFolioAskModelStore((s) => s.selection);
  const providers = useConfigStore((s) => s.providers);
  const currentProviderId = useConfigStore((s) => s.currentProviderId);
  const currentModelId = useConfigStore((s) => s.currentModelId);
  const currentVariant = useConfigStore((s) => s.currentVariant);
  const loadSkills = useSkillsStore((s) => s.loadSkills);
  // Skills belong to the directory they are read from, and a page conversation runs in its own.
  const skills = useSkillsStore((s) => selectSkillsForDirectory(s, chat?.directory));
  // The Chats group is built from the app's own session list, narrowed to the
  // conversations someone started: a subagent run is a child session, so it is
  // left out by that link rather than by the generated title it carries.
  const untitledLabel = t('folio.untitled');
  const chatsForPicker = React.useMemo(() => askMentionChats(sessions, untitledLabel), [sessions, untitledLabel]);
  const parentTitle = React.useCallback((id: string | undefined) => (id ? notes?.find((n) => n.id === id)?.title : undefined), [notes]);
  const groups = React.useMemo(() => (picker
    ? collectAskMentions(notes ?? [], chatsForPicker, skills, picker.query, parentTitle)
    : []), [chatsForPicker, notes, parentTitle, picker, skills]);
  const matches = React.useMemo(() => flattenAskMentions(groups), [groups]);
  // The one model this panel sends on. It is the pick when the user has made one,
  // and the app's current selection until then, and the send reads this value.
  const model = React.useMemo<AskModelSelection | undefined>(
    () => resolveAskModel(askSelection, { providerID: currentProviderId, modelID: currentModelId, variant: currentVariant }),
    [askSelection, currentModelId, currentProviderId, currentVariant],
  );

  React.useEffect(() => { if (chat?.directory) void loadSkills(chat.directory); }, [chat?.directory, loadSkills]);

  const track = (value: string, caret: number) => {
    const found = /(^|\s)@([^\s@]{0,40})$/.exec(value.slice(0, caret));
    if (found) { setPicker({ query: found[2], start: caret - found[2].length - 1 }); setPickIndex(0); } else setPicker(undefined);
  };
  const pick = (target: AskMention | undefined) => {
    const element = inputRef.current;
    if (!target || !picker || !element) { setPicker(undefined); return; }
    const caret = element.selectionStart ?? draft.length;
    const next = `${draft.slice(0, picker.start)}@${target.label} ${draft.slice(caret)}`;
    setDraft(next);
    if (target.kind !== 'chat') setMentions((old) => (old.some((m) => m.id === target.id) ? old : [...old, target]));
    setPicker(undefined);
    const at = picker.start + target.label.length + 2;
    requestAnimationFrame(() => { element.focus(); element.setSelectionRange(at, at); });
  };

  const remember = (next: Record<string, PageChat>) => { writePageChats(next); setChats(next); };

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || sending) return;
    if (!model) { setError(t('folio.askNoModel')); return; }
    setSending(true); setError(undefined);
    try {
      // The page is sent as it is on screen, so unsaved typing is saved first.
      await useFolioStore.getState().flush();
      const page = useFolioStore.getState().status?.notes.find((n) => n.id === note.id) ?? note;
      const modelRef = askModelRef(providers, model);
      let current = readPageChats()[note.id];
      if (!current) {
        const directory = await createChatDirectory();
        // The page conversation runs on Folio's own agent and ruleset, never on
        // the agent the ordinary chat is on: a worker handed a question about a
        // page goes looking for the source instead of answering from the page.
        const session = await createSession(page.title || t('folio.untitled'), directory, undefined, undefined,
          { model: modelRef, agent: FOLIO_ASK_AGENT, permissions: FOLIO_ASK_PERMISSIONS }, 'preserve');
        // Nothing was asked and nothing can be retried from a chat that never
        // started, which is a different failure from a turn the model refused.
        if (!session) throw new Error(t('folio.askSessionFailed'));
        current = { sessionId: session.id, directory: session.directory || directory };
      }
      // The page is the conversation's subject, so it is named first and sent in
      // full the first time and whenever it changed since; the mentions the
      // question refers to follow it.
      let context = `The user is asking a question about their Folio notebook page "${page.title || 'Untitled'}" (page id ${page.id}), which is the subject of this conversation. Answer from the page below.

You have access to the "folio" tool that finds, reads and edits notes and databases. Use it when the user asks you to change their notes or databases:
- folio.search to find pages by title or content
- folio.list to see what pages exist, optionally inside a parent page
- folio.read a page to see its content and, for a database, its columns, rows and views
- folio.update_block to change the text or properties of a specific block
- folio.append to add a new block at the end of a page
- folio.insert to insert a new block at a specific position
- folio.rename a page
- folio.create a new page
- folio.add_row, folio.update_row and folio.delete_row to change database rows
- folio.set_view to change a database's layout (table, board, gallery/card, list, chart)
- folio.delete_block to remove a block
The tool edits appear on the user's screen immediately. When the user says to fix or change something, use the tool rather than saying you cannot.

There is no project or filesystem here — but the notebook itself is fully explorable with folio.search and folio.list.`;
      if (page.excludedFromAI) context += ' This page is excluded from AI, so its content is not shared.';
      else if (current.sentModified !== page.modified) {
        const response = await useFolioStore.getState().api?.request({ command: 'markdown', noteID: page.id, flag: true });
        if (response?.ok && response.text) context += `\n\n<page title="${page.title || 'Untitled'}" pageId="${page.id}">\n\n${response.text}\n\n</page>`;
      }
      // Pages @mentioned in the question go along in full (pages excluded from AI only by name),
      // and a file brings the page it is attached to along the same way.
      const named = mentions.filter((m) => m.kind !== 'chat' && m.kind !== 'skill' && question.includes(`@${m.label}`));
      for (const mention of named) {
        const targetID = mention.pageID ?? mention.id;
        const target = useFolioStore.getState().status?.notes.find((n) => n.id === targetID);
        if (!target || target.id === page.id) continue;
        const label = mention.kind === 'file' ? `${mention.label} (attached to page "${target.title}")` : mention.label;
        if (target.excludedFromAI) { context += `\n\nThe user mentioned "${label}", which is excluded from AI.`; continue; }
        const response = await useFolioStore.getState().api?.request({ command: 'markdown', noteID: target.id, flag: true }).catch(() => undefined);
        if (response?.ok && response.text) context += `\n\nMentioned page "${target.title || 'Untitled'}" (page id ${target.id}), which the user referred to as "${label}":\n\n${response.text.slice(0, 80_000)}`;
      }
      // A named chat is read on demand through the agent tool, so only its identity travels.
      for (const mention of mentions.filter((m) => m.kind === 'chat' && question.includes(`@${m.label}`))) {
        context += `\n\nThe user mentioned the chat "${mention.label}" (session id ${mention.id}); read it with the openchamber tool when they refer to it.`;
      }
      const skillNames = mentions.filter((m) => m.kind === 'skill' && question.includes(`@${m.label}`)).map((m) => m.label);
      const sendOptions: AskSendOptions = { sessionId: current.sessionId, directory: current.directory };
      if (skillNames.length) sendOptions.skills = { names: skillNames, instructionFor: buildSkillMentionInstruction };
      // The agent travels with every turn, not only at creation: an existing page
      // conversation keeps this one, and a change in the ordinary chat cannot
      // move it, because this send never reads the chat's agent.
      await useSessionUIStore.getState().sendMessage(question, model.providerID, model.modelID, FOLIO_ASK_AGENT, undefined, undefined,
        [{ text: context, synthetic: true }], modelRef.variant, 'normal', sendOptions);
      remember({ ...readPageChats(), [note.id]: { ...current, sentModified: page.modified } });
      setDraft(''); setMentions([]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setSending(false); }
  };
  const newChat = () => { const next = { ...readPageChats() }; delete next[note.id]; remember(next); setDraft(''); inputRef.current?.focus(); };
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
    {error && <p role="alert" className="mx-3 mb-2 break-words rounded-md bg-[color-mix(in_srgb,var(--status-error)_12%,transparent)] px-2 py-1.5 text-xs">{error}</p>}
    <form className="relative m-3 mt-0 rounded-xl border border-border bg-background p-2 focus-within:border-foreground/30" onSubmit={(e) => { e.preventDefault(); void send(draft); }}>
      {picker && <div role="listbox" aria-label={t('folio.askMention')} className="absolute inset-x-0 bottom-full z-20 mb-1 max-h-72 overflow-y-auto rounded-xl border border-border bg-background p-1.5 shadow-2xl" onMouseDown={(e) => e.preventDefault()}>
        {!matches.length && <div className="px-2 py-1.5 text-sm text-muted-foreground">{t('folio.askNoMatches')}</div>}
        {/* An empty Chats group is otherwise invisible, so a session list that never
            arrived looks exactly like a notebook with no conversations in it. */}
        {!chatsForPicker.length && <div className="px-2 py-1.5 text-sm text-muted-foreground">{t('folio.askNoChats')}</div>}
        {groups.map((group) => <div key={group.kind} className="pb-1">
          <div className="px-2 pb-1 pt-0.5 text-xs text-muted-foreground">{t(groupKeys[group.kind])}</div>
          {group.items.map((target) => {
            const index = matches.indexOf(target);
            return <button key={`${target.kind}:${target.id}`} type="button" role="option" aria-selected={index === pickIndex}
              className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-interactive-hover', index === pickIndex && 'bg-interactive-selection')}
              onMouseMove={() => setPickIndex(index)} onClick={() => pick(target)}>
              {target.icon ? <FolioIcon value={target.icon} /> : <Icon name={mentionIcon[target.kind]} className="size-4 shrink-0 text-muted-foreground" />}
              <span className="min-w-0 flex-1 truncate">{target.label || t('folio.untitled')}</span>
              {target.detail && <span className="max-w-[40%] truncate text-xs text-muted-foreground">{target.detail}</span>}
            </button>;
          })}
        </div>)}
      </div>}
      <textarea ref={inputRef} rows={2} value={draft} onChange={(e) => { setDraft(e.target.value); track(e.target.value, e.target.selectionStart ?? e.target.value.length); }} placeholder={t('folio.askPlaceholder')} aria-label={t('folio.askPlaceholder')}
        className="block max-h-48 w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        onBlur={() => setPicker(undefined)}
        onKeyDown={(e) => {
          if (handleDropdownNavigationKey(e, (key) => setPickIndex(nextAskMentionIndex(pickIndex, matches.length, key === 'ArrowDown' ? 1 : -1)))) return;
          const action = askComposerAction(e.key, Boolean(picker), matches.length, e.shiftKey, e.nativeEvent.isComposing);
          if (action === 'move-next' || action === 'move-previous') { e.preventDefault(); setPickIndex(nextAskMentionIndex(pickIndex, matches.length, action === 'move-next' ? 1 : -1)); return; }
          if (action === 'choose') { e.preventDefault(); pick(matches[pickIndex]); return; }
          if (action === 'close') { e.preventDefault(); setPicker(undefined); return; }
          if (action === 'send') { e.preventDefault(); void send(draft); }
        }} />
      <div className="flex items-center justify-between gap-1">
        <FolioAskModelPicker />
        <button type="submit" disabled={!draft.trim() || sending} className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40" aria-label={t('folio.send')}><Icon name="arrow-up" className="size-4" /></button>
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
        {message.error && <p className="break-words text-xs text-[var(--status-error)]">{t('folio.askFailedReason', { reason: message.error.message || t('folio.askFailed') })}</p>}
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

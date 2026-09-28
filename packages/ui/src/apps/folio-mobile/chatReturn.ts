import React from 'react';
import { create } from 'zustand';
import { useFolioStore } from '@/lib/folio/store';
import { useMobileChatStore } from './chatStore';
import type { MobileView } from './FolioMobileHome';

interface ChatReturnState {
  /** The conversation the page in front of the user came out of; absent when it came from anywhere else. */
  chatID?: string;
  remember: (chatID: string) => void;
  forget: () => void;
}

/**
 * The conversation a page was opened from. The iPhone app shows one surface at a time, so a page the
 * user tapped inside a reply leaves the conversation underneath with nothing on screen to bring it
 * back; this is where its id is kept, so the page can hand the user there again in a single tap.
 */
export const useChatReturnStore = create<ChatReturnState>((set) => ({
  remember: (chatID) => set({ chatID }),
  forget: () => set({ chatID: undefined }),
}));

/**
 * Reopens the conversation a page came out of, exactly as it was left. False when there is nothing to
 * go back to, or the conversation is no longer on this phone, so the caller can go Home rather than
 * open an empty chat in its place.
 */
export function returnToChat(): boolean {
  const remembered = useChatReturnStore.getState();
  const chatID = remembered.chatID;
  const chats = useMobileChatStore.getState();
  if (!chatID || !chats.chats.some((chat) => chat.id === chatID)) { remembered.forget(); return false; }
  chats.open(chatID);
  return true;
}

/**
 * Shows the page the user selected, and remembers the conversation it came out of.
 *
 * Tapping a page inside a conversation is the one way into a page that leaves a conversation behind, so
 * that conversation is remembered while the page is in front — including when a meeting reminder
 * interrupts the user mid-conversation, because that conversation is what they were reading. Every
 * other way in forgets it: Home, search, the calendar, a page the native editor opened itself, or a page
 * that replaces the one in front. A way back to a conversation the page did not come from sends the user
 * somewhere they did not ask to go, and leaving the page spends the memory either way.
 */
export function useNoteFromChat(view: MobileView, showPage: () => void): void {
  const selectedID = useFolioStore((s) => s.status?.selectedID);
  const showPageNow = React.useRef(showPage);
  showPageNow.current = showPage;
  /** The screen and the page of the pass before this one, which is the step the user has just taken. */
  const before = React.useRef({ view, selectedID });
  React.useEffect(() => {
    const previous = before.current;
    before.current = { view, selectedID };
    const remembered = useChatReturnStore.getState();
    const activeID = useMobileChatStore.getState().activeID;
    if (view === 'notes' && previous.view === 'chat' && activeID) remembered.remember(activeID);
    else if (view !== 'notes' || selectedID !== previous.selectedID) remembered.forget();
    // The first selection after launch is only the page the app was left on, so the app opens on Home.
    if (previous.selectedID !== undefined && selectedID && previous.selectedID !== selectedID) showPageNow.current();
  }, [view, selectedID]);
}

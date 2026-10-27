import { useGeminiStore } from '@/stores/useGeminiStore';
import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { isChatGPTChatPath } from '@/lib/chatgpt/website';
import { useChatGPTStore } from '@/stores/useChatGPTStore';
import { useVeniceStore } from '@/stores/useVeniceStore';
import { useClaudeStore } from '@/stores/useClaudeStore';
import type { SessionTabMenuComponents } from './SessionTabsStrip';

type ItemProps = { Item: SessionTabMenuComponents['Item'] };

function ChatGPTPinMenuItem({ Item }: ItemProps) {
  const { t } = useI18n();
  const path = useChatGPTStore(state => state.activePath);
  const eligible = useChatGPTStore(state => state.status === 'ready' && isChatGPTChatPath(state.activePath)
    && state.chats.some(chat => chat.path === state.activePath));
  const pinned = useChatGPTStore(state => state.pinnedPaths.includes(path));
  return <Item disabled={!eligible} onClick={() => {
    const state = useChatGPTStore.getState();
    if (state.status === 'ready' && state.activePath === path && state.chats.some(chat => chat.path === path)) state.togglePin(path);
  }}>
    <Icon name="pushpin" className="mr-1 size-4" />
    {t(pinned ? 'header.sessionTabs.unpinSidebar' : 'header.sessionTabs.pinSidebar')}
  </Item>;
}

function SavedPagePinMenuItem({ Item, pageUrl, pageTitle, savedPages, toggleSavedPage }: ItemProps & {
  pageUrl: string | null;
  pageTitle: string;
  savedPages: Array<{ url: string; title: string }>;
  toggleSavedPage: () => void;
}) {
  const { t } = useI18n();
  // No route inference: these are explicitly saved observed pages, not chat IDs.
  const eligible = Boolean(pageUrl && pageTitle && new URL(pageUrl).pathname !== '/');
  const pinned = savedPages.some(page => page.url === pageUrl);
  return <Item disabled={!eligible} onClick={toggleSavedPage}>
    <Icon name="pushpin" className="mr-1 size-4" />
    {t(pinned ? 'header.sessionTabs.unpinSidebar' : 'header.sessionTabs.pinSidebar')}
  </Item>;
}

function ClaudePinMenuItem({ Item }: ItemProps) {
  const state = useClaudeStore();
  return <SavedPagePinMenuItem Item={Item} {...state} toggleSavedPage={() => {
    const current = useClaudeStore.getState();
    if (current.pageUrl === state.pageUrl && current.pageTitle === state.pageTitle) current.toggleSavedPage();
  }} />;
}

function VenicePinMenuItem({ Item }: ItemProps) {
  const state = useVeniceStore();
  return <SavedPagePinMenuItem Item={Item} {...state} toggleSavedPage={() => {
    const current = useVeniceStore.getState();
    if (current.pageUrl === state.pageUrl && current.pageTitle === state.pageTitle) current.toggleSavedPage();
  }} />;
}
function GeminiPinMenuItem({ Item }: ItemProps) {
  const state = useGeminiStore();
  return <SavedPagePinMenuItem Item={Item} {...state} toggleSavedPage={() => {
    const current = useGeminiStore.getState();
    if (current.pageUrl === state.pageUrl && current.pageTitle === state.pageTitle) current.toggleSavedPage();
  }} />;
}

export function WebsiteTabPinMenuItem({ tabId, Item }: ItemProps & { tabId: string }) {
  if (tabId === 'website:chatgpt') return <ChatGPTPinMenuItem Item={Item} />;
  if (tabId === 'website:gemini') return <GeminiPinMenuItem Item={Item} />;
  if (tabId === 'website:venice') return <VenicePinMenuItem Item={Item} />;
  if (tabId === 'website:claude') return <ClaudePinMenuItem Item={Item} />;
  return null;
}

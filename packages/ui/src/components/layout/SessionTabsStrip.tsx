import React from 'react';
import { useSessionTurnActive } from '@/sync/global-session-status';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { ContextMenu } from '@base-ui/react/context-menu';
import type { Session } from '@/lib/opencode/model';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { dropdownMenuItemClass, dropdownMenuPopupClass, dropdownMenuSeparatorClass } from '@/components/ui/dropdown-menu.styles';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useSessionTabsStore } from '@/stores/useSessionTabsStore';
import { activateHeaderTab, cancelNewHeaderTab, closeSessionTabAndActivateNeighbour, getWebsiteTab, isWebsiteTabAvailable, openNewHeaderTab } from '@/lib/sessionTabs';
import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionUnseenCount } from '@/sync/notification-store';
import { useIsSessionAiRenamePending } from '@/sync/use-session-ai-rename';
import { useMultiRunMemberIds } from '@/lib/multirun/useMultiRuns';
import { useUIStore } from '@/stores/useUIStore';
import { useMuseStore } from '@/stores/useMuseStore';
import { Button } from '@/components/ui/button';
import { WebsiteTabPinMenuItem } from './WebsiteTabPinMenuItem';
import { handleDropdownNavigationKey } from '@/components/ui/dropdown-navigation';

const restrictToXAxis: Modifier = ({ transform }) => ({ ...transform, y: 0 });

type SessionTab = { id: string; session: Session };
type WebsiteTab = { id: string; title: string };

const WebsiteTabItem: React.FC<{
  tab: WebsiteTab;
  isActive: boolean;
  onClose: (id: string) => void;
}> = ({ tab, isActive, onClose }) => {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: DndCSS.Translate.toString(transform), transition }}
      className={cn(
        'session-tab-slot group/session-tab flex h-7 w-[200px] min-w-[88px] touch-none items-center rounded-md',
        isDragging && 'z-10 opacity-60',
        isActive
          ? 'bg-interactive-selection text-interactive-selection-foreground'
          : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
      )}
      data-active={isActive ? 'true' : 'false'}
      data-active-session-tab={isActive || undefined}
      {...attributes}
      {...listeners}
    >
      <ContextMenu.Root>
      <ContextMenu.Trigger render={<div className="flex min-w-0 flex-1 items-center" />}>
      <Button
        variant="ghost"
        size="xs"
        role="tab"
        aria-selected={isActive}
        title={tab.title}
        onClick={() => activateHeaderTab(tab.id)}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          onClose(tab.id);
        }}
        className="h-full min-w-0 flex-1 justify-start px-2 text-left text-[13px] font-medium leading-4 normal-case text-inherit hover:bg-transparent hover:text-inherit"
      >
        <span className="min-w-0 truncate">{tab.title}</span>
      </Button>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="app-region-no-drag z-50">
          <ContextMenu.Popup className={cn(dropdownMenuPopupClass, 'min-w-[190px]')} onKeyDown={handleContextMenuNavigation}>
            <WebsiteTabPinMenuItem tabId={tab.id} Item={contextComponents.Item} />
            <contextComponents.Separator />
            <contextComponents.Item onClick={() => onClose(tab.id)}>{t('header.sessionTabs.closeTab')}</contextComponents.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
      </ContextMenu.Root>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs" aria-label={t('header.sessionTabs.tabMenuAria')}
            onPointerDown={event => event.stopPropagation()}
            className="size-5 shrink-0 p-0 opacity-0 group-hover/session-tab:opacity-100 group-focus-within/session-tab:opacity-100">
            <Icon name="more" className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[190px]">
          <WebsiteTabPinMenuItem tabId={tab.id} Item={DropdownMenuItem} />
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onClose(tab.id)}>{t('header.sessionTabs.closeTab')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="xs"
        aria-label={t('header.sessionTabs.closeTab')}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); onClose(tab.id); }}
        className="mr-1 size-5 shrink-0 p-0 opacity-0 group-hover/session-tab:opacity-100 group-focus-within/session-tab:opacity-100"
      >
        <Icon name="close" className="size-4" />
      </Button>
    </div>
  );
};

export type SessionTabMenuComponents = {
  Item: React.ComponentType<{
    className?: string;
    disabled?: boolean;
    onClick?: React.MouseEventHandler;
    children?: React.ReactNode;
  }>;
  Separator: React.ComponentType<{ className?: string }>;
};

export type SessionTabMenuArgs = {
  session: Session;
  open: boolean;
  isActive: boolean;
  select: () => void;
  closeOtherTabs: () => void;
  /** Menu primitives for the surface the menu opens in (dropdown or context menu). */
  components: SessionTabMenuComponents;
};

const dropdownComponents: SessionTabMenuComponents = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
};

const contextComponents: SessionTabMenuComponents = {
  Item: ({ className, ...props }) => (
    <ContextMenu.Item className={cn(dropdownMenuItemClass, className)} {...props} />
  ),
  Separator: ({ className, ...props }) => (
    <ContextMenu.Separator className={cn(dropdownMenuSeparatorClass, className)} {...props} />
  ),
};

const handleContextMenuNavigation: React.KeyboardEventHandler<HTMLElement> = event => {
  handleDropdownNavigationKey(event, key => {
    event.currentTarget.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
};

/**
 * One tab, active or not. The tab drags to reorder; the menu and close
 * controls sit in a hover-revealed overlay at the tab's end (menu first,
 * close after it). One session menu — supplied by the header via
 * `renderMenu` — backs both the "..." dropdown and the right-click context
 * menu, which opens under the cursor without changing the active tab. The
 * dropdown's anchor overlay stays mounted through the close animation so the
 * popup never flashes detached. While the active tab is renaming, the
 * overlay is suppressed entirely — only the rename controls show.
 */
const SessionTabItem: React.FC<{
  tab: SessionTab;
  isActive: boolean;
  suppressControls: boolean;
  onSelect: (tab: SessionTab) => void;
  onClose: (id: string) => void;
  renderMenu: (args: SessionTabMenuArgs) => React.ReactNode;
  closeOtherTabs: (id: string) => void;
  onMenuOpenChangeComplete?: (open: boolean) => void;
  children?: React.ReactNode;
}> = ({ tab, isActive, suppressControls, onSelect, onClose, renderMenu, closeOtherTabs, onMenuOpenChangeComplete, children }) => {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = React.useState(false);
  // Keeps the overlay (the dropdown's anchor) mounted through the close animation.
  const [menuVisible, setMenuVisible] = React.useState(false);
  const [contextMenuOpen, setContextMenuOpen] = React.useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });

  const title = tab.session.title?.trim() || t('sessions.sidebar.session.untitled');
  const overlayVisible = !suppressControls && (menuOpen || menuVisible);

  // Session state for the dot and the hover tooltip.
  const isAiRenaming = useIsSessionAiRenamePending(tab.id, resolveGlobalSessionDirectory(tab.session));
  const isStreaming = useSessionTurnActive(tab.id);
  const unseenCount = useSessionUnseenCount(tab.id);
  const showUnread = unseenCount > 0 && !isActive && !isStreaming;
  const showDot = isStreaming || showUnread;
  const dotLabel = isStreaming
    ? t('sessions.sidebar.session.status.active')
    : t('sessions.sidebar.session.status.unread');

  const menuArgsFor = (components: SessionTabMenuComponents): SessionTabMenuArgs => ({
    session: tab.session,
    open: menuOpen || contextMenuOpen,
    isActive,
    select: () => onSelect(tab),
    closeOtherTabs: () => closeOtherTabs(tab.id),
    components,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: DndCSS.Translate.toString(transform), transition }}
      className={cn('session-tab-slot flex h-7 w-[200px] min-w-[88px] touch-none', isDragging && 'z-10 opacity-60')}
      data-active={isActive ? 'true' : 'false'}
      {...(isActive ? { 'data-active-session-tab': true } : {})}
      {...attributes}
      {...listeners}
    >
      <ContextMenu.Root
        open={contextMenuOpen}
        onOpenChange={setContextMenuOpen}
        onOpenChangeComplete={(open) => onMenuOpenChangeComplete?.(open)}
      >
        <ContextMenu.Trigger
              render={(triggerProps) => (
                <div
                  {...triggerProps}
                  role="tab"
                  aria-selected={isActive}
                   tabIndex={0}
                  onClick={isActive ? undefined : () => onSelect(tab)}
                  onKeyDown={isActive ? undefined : (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect(tab);
                    }
                  }}
                  onAuxClick={(event) => {
                    if (event.button === 1) {
                      event.preventDefault();
                      onClose(tab.id);
                    }
                  }}
                  data-controls-open={overlayVisible ? 'true' : 'false'}
                  className={cn(
                    // No color transition: activation must snap. A crossfade
                    // here reads as the switch itself being slow, since the
                    // old and new tab trade colors over several frames right
                    // after the click.
                    'session-tab group/session-tab relative flex h-7 w-full min-w-0 select-none items-center rounded-md px-2',
                    isActive
                      ? 'bg-interactive-selection text-interactive-selection-foreground'
                      : cn(
                        'cursor-pointer text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
                        overlayVisible && 'bg-interactive-hover text-foreground',
                      ),
                  )}
                >
                  <div className={cn(
                    'flex min-w-0 flex-1 items-center',
                    !suppressControls && 'group-hover/session-tab:pr-10',
                    overlayVisible && 'pr-10',
                  )}
                  >
                    <div className={cn(
                      'min-w-0 flex-1 overflow-hidden whitespace-nowrap',
                      !suppressControls && 'session-tab-title',
                    )}
                    >
                      {/* Same box as the active content the header renders
                          (a centered column with a block title), so the
                          title sits at the same height before and after
                          activation and does not jump when the tab swaps
                          its content. */}
                      {isActive ? children : (
                        <div className="flex min-w-0 flex-col justify-center">
                          <span className="block max-w-full overflow-hidden whitespace-nowrap text-[13px] font-medium leading-4">{title}</span>
                        </div>
                      )}
                    </div>
                    {isAiRenaming ? (
                      <Icon name="loader-4" className="ml-1.5 size-3 shrink-0 animate-spin text-primary" aria-label={t('sessions.aiRename.generating')} />
                    ) : showDot ? (
                      <SessionActivityIndicator
                        state={isStreaming ? 'running' : 'unread'}
                        label={dotLabel}
                        className={cn('ml-1.5 shrink-0', !suppressControls && 'group-hover/session-tab:opacity-0', overlayVisible && 'opacity-0')}
                      />
                    ) : null}
                  </div>
                  {!suppressControls ? (
                    <div
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                      className={cn(
                        'absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5',
                        'opacity-0 transition-opacity duration-150',
                         'group-hover/session-tab:flex group-hover/session-tab:opacity-100 group-focus-within/session-tab:flex group-focus-within/session-tab:opacity-100',
                        overlayVisible && 'flex opacity-100',
                      )}
                    >
                      <DropdownMenu
                        open={menuOpen}
                        onOpenChange={(open) => {
                          setMenuOpen(open);
                          if (open) setMenuVisible(true);
                        }}
                        onOpenChangeComplete={(open) => {
                          if (!open) setMenuVisible(false);
                          onMenuOpenChangeComplete?.(open);
                        }}
                      >
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label={t('header.sessionTabs.tabMenuAria')}
                            className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                          >
                            <Icon name="more" className="size-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="min-w-[190px]">
                          {renderMenu(menuArgsFor(dropdownComponents))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <button
                        type="button"
                        aria-label={t('header.sessionTabs.closeTab')}
                        onClick={() => onClose(tab.id)}
                        className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                      >
                        <Icon name="close" className="size-4" />
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
        />
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="app-region-no-drag z-50">
            <ContextMenu.Popup
              onKeyDown={handleContextMenuNavigation}
              data-slot="dropdown-menu-content"
              style={{ color: 'var(--surface-elevated-foreground)' }}
              className={cn(dropdownMenuPopupClass, 'min-w-[190px]')}
            >
              {renderMenu(menuArgsFor(contextComponents))}
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </div>
  );
};

/**
 * The header's horizontal working set of sessions and singleton websites.
 *
 * Every session the user opens joins the strip once; the tab whose session is
 * current renders `children` — the header's title/rename block — inside a
 * selected pill. Closing a tab only removes it from the strip; closing the
 * active one activates its neighbour. Ids whose session has not loaded (or
 * was archived/deleted) stay in the store but do not render, so a partial
 * session list never destroys the working set. Local Electron websites share
 * this order and resume their retained workspace rather than creating chats.
 */
export const SessionTabsStrip: React.FC<{
  /** Menu items for one tab's session, supplied by the header. */
  renderMenu: (args: SessionTabMenuArgs) => React.ReactNode;
  /** Fires when a tab menu finishes opening/closing (deferred rename hook). */
  onMenuOpenChangeComplete?: (open: boolean) => void;
  /** While the active tab renames, its hover controls stay hidden. */
  suppressActiveTabControls?: boolean;
  children: React.ReactNode;
}> = ({ renderMenu, onMenuOpenChangeComplete, suppressActiveTabControls = false, children }) => {
  const { t } = useI18n();
  const tabIds = useSessionTabsStore((state) => state.tabIds);
  const navigateTab = useSessionTabsStore((state) => state.navigateTab);
  const newTabPending = useSessionTabsStore((state) => state.newTabPending);
  const closeOtherTabs = useSessionTabsStore((state) => state.closeOtherTabs);
  const reorderTabs = useSessionTabsStore((state) => state.reorderTabs);

  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const activeSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const isChatGPTPageOpen = useUIStore((state) => state.isChatGPTPageOpen);
  const isMusePageOpen = useUIStore((state) => state.isMusePageOpen);
  const isClaudePageOpen = useUIStore((state) => state.isClaudePageOpen);
  const musePageTitle = useMuseStore((state) => state.pageTitle);
  const activeWebsiteId = isChatGPTPageOpen ? 'website:chatgpt' : isMusePageOpen ? 'website:muse' : isClaudePageOpen ? 'website:claude' : null;
  const activeTabId = activeWebsiteId ?? currentSessionId;
  const websitesAvailable = isWebsiteTabAvailable();

  // Notion-style navigation: opening a session anywhere (sidebar, palette, deep
  // link) replaces the focused tab in place. Only the + button (or "Open in new
  // tab") grows the strip. The lanes of one multi-run share a tab.
  const currentRunMemberIds = useMultiRunMemberIds(currentSessionId);
  React.useEffect(() => {
    if (activeWebsiteId) navigateTab(activeWebsiteId);
    else if (currentSessionId) navigateTab(currentSessionId, currentRunMemberIds);
  }, [activeWebsiteId, currentSessionId, currentRunMemberIds, navigateTab]);

  const sessionsById = React.useMemo(() => {
    const map = new Map<string, Session>();
    for (const session of activeSessions) map.set(session.id, session);
    return map;
  }, [activeSessions]);

  // Only tabs with a known live session render; unknown ids stay stored.
  const tabs = React.useMemo<Array<SessionTab | WebsiteTab>>(() => {
    const list: Array<SessionTab | WebsiteTab> = [];
    for (const id of tabIds) {
      const website = websitesAvailable ? getWebsiteTab(id) : null;
      if (website) {
        list.push({ id, title: id === 'website:muse' && musePageTitle ? musePageTitle : website.title });
        continue;
      }
      const session = sessionsById.get(id);
      if (session) list.push({ id, session });
    }
    return list;
  }, [tabIds, sessionsById, websitesAvailable, musePageTitle]);

  const handleSelect = React.useCallback((tab: SessionTab) => {
    activateHeaderTab(tab.id);
  }, []);

  const handleClose = React.useCallback((id: string) => {
    closeSessionTabAndActivateNeighbour(id);
  }, []);

  const handleCloseOthers = React.useCallback((id: string) => {
    closeOtherTabs(id);
    activateHeaderTab(id);
  }, [closeOtherTabs]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      reorderTabs(String(active.id), String(over.id));
    }
  }, [reorderTabs]);

  // Tabs shrink to share the strip (no edge fade); past the minimum width the
  // strip scrolls and keeps the active tab in view.
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  // Keep the active tab in view when it changes.
  React.useEffect(() => {
    scrollRef.current
      ?.querySelector('[data-active-session-tab]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId, tabs.length]);

  const tabIdsInOrder = React.useMemo(() => tabs.map((tab) => tab.id), [tabs]);

  // A brand-new draft (no session yet) shows as a transient active pill after
  // the tabs; it becomes a real tab once the first message creates the session.
  const showDraftPill = !activeWebsiteId && newTabPending && (!currentSessionId || !tabs.some((tab) => tab.id === currentSessionId));

  return (
    <div className="app-region-no-drag flex h-full min-w-0 flex-1 items-center" role="tablist" aria-label={t('header.sessionTabs.stripAria')}>
      <div
        ref={scrollRef}
        className="session-tabs-scroll flex min-w-0 flex-initial items-center gap-1 overflow-x-auto overscroll-x-contain"
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToXAxis]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={tabIdsInOrder} strategy={horizontalListSortingStrategy}>
            {tabs.map((tab) => 'session' in tab ? (
              <SessionTabItem
                key={tab.id}
                tab={tab}
                isActive={tab.id === activeTabId}
                suppressControls={tab.id === activeTabId && suppressActiveTabControls}
                onSelect={handleSelect}
                onClose={handleClose}
                renderMenu={renderMenu}
                closeOtherTabs={handleCloseOthers}
                onMenuOpenChangeComplete={onMenuOpenChangeComplete}
              >
                {tab.id === activeTabId ? children : null}
              </SessionTabItem>
            ) : <WebsiteTabItem key={tab.id} tab={tab} isActive={tab.id === activeTabId} onClose={handleClose} />)}
          </SortableContext>
        </DndContext>
        {showDraftPill ? (
          <div
            role="tab"
            aria-selected
            className="session-tab-slot session-tab-enter group/session-tab flex h-7 w-[200px] min-w-[88px] items-center rounded-md bg-interactive-selection pl-2 pr-1"
            data-active="true"
            data-active-session-tab
          >
            <div className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-[13px] font-medium leading-4 text-foreground">{t('header.sessionTabs.newTab')}</div>
            <button
              type="button"
              aria-label={t('header.sessionTabs.closeTab')}
              onClick={() => cancelNewHeaderTab()}
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/session-tab:opacity-100"
            >
              <Icon name="close" className="size-4" />
            </button>
          </div>
        ) : null}
      </div>
      <button
        type="button"
        aria-label={t('header.sessionTabs.newTab')}
        title={t('header.sessionTabs.newTab')}
        onClick={() => openNewHeaderTab()}
        className="session-tab-new ml-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-[background-color,color,transform] duration-150 hover:bg-interactive-hover hover:text-foreground active:scale-90"
      >
        <Icon name="add" className="size-4" />
      </button>
    </div>
  );
};

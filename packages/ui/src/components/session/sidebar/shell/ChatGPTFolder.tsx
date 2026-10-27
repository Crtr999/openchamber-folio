import React from 'react';
import { Button } from '@/components/ui/button';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Icon } from '@/components/icon/Icon';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { isElectronShell, isDesktopLocalOriginActive } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';
import { useChatGPTStore } from '@/stores/useChatGPTStore';
import { useI18n } from '@/lib/i18n';
import { WebsiteFolderHeader, type WebsiteFolderEmbedProps } from './WebsiteFolderHeader';

export function ChatGPTFolder({ embedded = false, dragAttributes, dragListeners }: WebsiteFolderEmbedProps = {}): React.ReactNode {
  const { t } = useI18n();
  const selected = useUIStore(s => s.isChatGPTPageOpen);
  const expanded = useChatGPTStore(s => s.expanded);
  const chats = useChatGPTStore(s => s.chats);
  const projects = useChatGPTStore(s => s.projects);
  const active = useChatGPTStore(s => s.activePath);
  const pins = useChatGPTStore(s => s.pinnedPaths);
  const status = useChatGPTStore(s => s.status);
  if (!isElectronShell() || !isDesktopLocalOriginActive()) return null;
  const rows = [...chats.filter(chat => pins.includes(chat.path)), ...chats.filter(chat => !pins.includes(chat.path))];
  return <div className={embedded ? undefined : 'mt-3'}>
    <WebsiteFolderHeader label={t('chatgpt.websiteHistory')} logo={<ProviderLogo providerId="chatgpt" alt="" className="size-5 shrink-0" />} selected={selected} expanded={expanded} controlsId="chatgpt-sidebar-pages" onOpen={() => useChatGPTStore.getState().open(undefined, 'full')} onToggle={() => useChatGPTStore.getState().toggleExpanded()} dragAttributes={dragAttributes} dragListeners={dragListeners}>
      <Button variant="ghost" size="xs" aria-label={t('chatgpt.new')} onClick={() => useChatGPTStore.getState().open({ kind: 'navigate', path: '/' })}><Icon name="add" className="size-3.5" /></Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" size="xs" aria-label={t('chatgpt.tools')}><Icon name="more" className="size-3.5" /></Button></DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start">
          {(['Health', 'Library', 'Plugins', 'Explore', 'Projects', 'Scheduled'] as const).map(label => <DropdownMenuItem key={label} onSelect={() => useChatGPTStore.getState().open({ kind: 'shortcut', label }, 'full')}>{t(`chatgpt.${label}`)}</DropdownMenuItem>)}
          <DropdownMenuItem onSelect={() => useChatGPTStore.getState().open(undefined, 'full')}>{t('chatgpt.full')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => useChatGPTStore.getState().open({ kind: 'refresh' })}>{t('openrouter.credits.refresh')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </WebsiteFolderHeader>
    {expanded && <div id="chatgpt-sidebar-pages" className="ml-5 space-y-0.5">
      {projects.map(project => <Button key={project.path} size="sm" variant="ghost" className="w-full justify-start gap-2" onClick={() => useChatGPTStore.getState().open({ kind: 'navigate', path: project.path }, 'full')}><Icon name="folder" className="size-3.5 shrink-0" /><span className="truncate">{project.title}</span></Button>)}
      {rows.map(chat => <div key={chat.path} className="group flex items-center">
        <Button variant={selected && active === chat.path ? 'secondary' : 'ghost'} size="sm" className="min-w-0 flex-1 justify-start gap-1.5" title={chat.title} onClick={() => useChatGPTStore.getState().open({ kind: 'navigate', path: chat.path })}>
          {pins.includes(chat.path) && <Icon name="pushpin" className="size-3 shrink-0" />}<span className="truncate">{chat.title}</span>
        </Button>
        <Button variant="ghost" size="xs" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" aria-label={t(pins.includes(chat.path) ? 'sessions.sidebar.session.menu.unpin' : 'sessions.sidebar.session.menu.pin')} title={t('chatgpt.localPins')} onClick={() => useChatGPTStore.getState().togglePin(chat.path)}><Icon name="pushpin" className="size-3" /></Button>
      </div>)}
      {status !== 'ready' && <p className="px-2 py-1 text-xs text-muted-foreground" role="status">{t(status === 'signed-out' ? 'chatgpt.signIn' : status === 'unavailable' ? 'chatgpt.unavailable' : 'common.loading')}</p>}
      {status === 'ready' && <Button variant="ghost" size="xs" className="w-full justify-start text-muted-foreground" onClick={() => useChatGPTStore.getState().open({ kind: 'older' })}>{t('chatgpt.older')}</Button>}
    </div>}
  </div>;
}

import React from 'react';
import { Button } from '@/components/ui/button';
import { MuseLogo } from '@/components/ui/MuseLogo';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { isElectronShell, isDesktopLocalOriginActive } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';
import { useMuseStore } from '@/stores/useMuseStore';
import { WebsiteFolderHeader } from './WebsiteFolderHeader';

/** User-saved pages only. Muse account history has not been verified. */
export function MuseFolder(): React.ReactNode {
  const { t } = useI18n();
  const selected = useUIStore(state => state.isMusePageOpen);
  const pageTitle = useMuseStore(state => state.pageTitle);
  const pageUrl = useMuseStore(state => state.pageUrl);
  const expanded = useMuseStore(state => state.expanded);
  const savedPages = useMuseStore(state => state.savedPages);
  if (!isElectronShell() || !isDesktopLocalOriginActive()) return null;
  return <div className="mt-3">
    <WebsiteFolderHeader label="Muse" logo={<MuseLogo className="size-3.5" />} selected={selected} expanded={expanded} controlsId="muse-sidebar-pages" onOpen={() => useMuseStore.getState().open()} onToggle={() => useMuseStore.getState().toggleExpanded()} />
    {expanded && <div id="muse-sidebar-pages" className="ml-5 space-y-0.5">
      <Button variant={selected ? 'secondary' : 'ghost'} size="xs" aria-pressed={selected} className="w-full justify-start" title={pageTitle || t('muse.resume')} onClick={() => useMuseStore.getState().open()}><span className="truncate">{t('muse.resume')}</span></Button>
      {savedPages.map(page => <div key={page.url} className="group flex min-w-0 items-center">
        <Button variant={selected && pageUrl === page.url ? 'secondary' : 'ghost'} size="xs" aria-pressed={selected && pageUrl === page.url} className="min-w-0 flex-1 justify-start gap-1.5" title={page.title} onClick={() => useMuseStore.getState().openSavedPage(page.url)}><Icon name="pushpin" className="size-3 shrink-0" /><span className="truncate">{page.title}</span></Button>
        <Button variant="ghost" size="xs" className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" aria-label={t('muse.unpin')} title={t('muse.unpin')} onClick={() => useMuseStore.getState().removeSavedPage(page.url)}><Icon name="close" className="size-3" /></Button>
      </div>)}
    </div>}
  </div>;
}

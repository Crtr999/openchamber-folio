import React from 'react';
import { Button } from '@/components/ui/button';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { Icon } from '@/components/icon/Icon';
import { isElectronShell, isDesktopLocalOriginActive } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';
import { useVeniceStore } from '@/stores/useVeniceStore';
import { useI18n } from '@/lib/i18n';
import { WebsiteFolderHeader } from './WebsiteFolderHeader';

/** Resume metadata only. Venice keeps its account history in its own sidebar. */
export function VeniceFolder(): React.ReactNode {
  const { t } = useI18n();
  const blocked = useEnterpriseMode();
  const selected = useUIStore(state => state.isVenicePageOpen);
  const pageTitle = useVeniceStore(state => state.pageTitle);
  const pageUrl = useVeniceStore(state => state.pageUrl);
  const savedPages = useVeniceStore(state => state.savedPages);
  const [expanded, setExpanded] = React.useState(false);
  if (blocked || !isElectronShell() || !isDesktopLocalOriginActive()) return null;
  return <div className="mt-3">
    <WebsiteFolderHeader label="Venice" logo={<ProviderLogo providerId="opencarter-venice-website" alt="" className="size-3.5 shrink-0" />} selected={selected} expanded={expanded} controlsId="venice-sidebar-pages" onOpen={() => useVeniceStore.getState().open()} onToggle={() => setExpanded(value => !value)} />
    {expanded && <div id="venice-sidebar-pages" className="ml-5 space-y-0.5">
      {pageTitle && <Button variant={selected ? 'secondary' : 'ghost'} size="xs" className="w-full justify-start" title={pageTitle} onClick={() => useVeniceStore.getState().open()}><span className="truncate">{pageTitle}</span></Button>}
      {savedPages.map(page => <div key={page.url} className="group flex min-w-0 items-center">
        <Button variant={selected && pageUrl === page.url ? 'secondary' : 'ghost'} size="xs" aria-pressed={selected && pageUrl === page.url} className="min-w-0 flex-1 justify-start gap-1.5" title={page.title} onClick={() => useVeniceStore.getState().openSavedPage(page.url)}><Icon name="pushpin" className="size-3 shrink-0" /><span className="truncate">{page.title}</span></Button>
        <Button variant="ghost" size="xs" className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" aria-label={t('venice.unpin')} title={t('venice.unpin')} onClick={() => useVeniceStore.getState().removeSavedPage(page.url)}><Icon name="close" className="size-3" /></Button>
      </div>)}
      <p className="px-2 py-1 typography-meta text-muted-foreground">{t('venice.savedPages')}</p>
    </div>}
  </div>;
}

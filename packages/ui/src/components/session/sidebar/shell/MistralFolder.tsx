import React from 'react';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { isElectronShell, isDesktopLocalOriginActive } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';
import { useMistralStore } from '@/stores/useMistralStore';
import { WebsiteFolderHeader, type WebsiteFolderEmbedProps } from './WebsiteFolderHeader';

/** Opens the Mistral console, where the account signs in and the usage meter reads. */
export function MistralFolder({ embedded = false, dragAttributes, dragListeners }: WebsiteFolderEmbedProps = {}): React.ReactNode {
  const blocked = useEnterpriseMode();
  const selected = useUIStore(state => state.isMistralPageOpen);
  const pageTitle = useMistralStore(state => state.pageTitle);
  if (blocked || !isElectronShell() || !isDesktopLocalOriginActive()) return null;
  return <div className={embedded ? undefined : 'mt-3'}>
    <WebsiteFolderHeader label="Mistral" logo={<ProviderLogo providerId="mistral-website" alt="" className="size-5 shrink-0" />} selected={selected} expanded={false} controlsId="mistral-sidebar-pages" onOpen={() => useMistralStore.getState().open()} onToggle={() => useMistralStore.getState().open()} dragAttributes={dragAttributes} dragListeners={dragListeners} />
    {pageTitle && !embedded && <p className="ml-5 px-2 py-1 typography-meta text-muted-foreground">{pageTitle}</p>}
  </div>;
}

import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { isSessionPinned, useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import type { SessionTabMenuComponents } from './SessionTabsStrip';

export function HeaderSessionPinMenuItem({ sessionId, directory: sessionDirectory, Item }: {
  sessionId: string;
  directory: string | null;
  Item: SessionTabMenuComponents['Item'];
}) {
  const { t } = useI18n();
  const runtime = getRuntimeKey();
  const current = useGlobalSessionsStore(state => state.entityById.get(sessionId));
  const directory = current ? resolveGlobalSessionDirectory(current) : sessionDirectory;
  const pinned = useSessionPinnedStore(state => isSessionPinned(state.ids, directory, sessionId));
  return <Item disabled={!directory} onClick={() => {
    if (getRuntimeKey() !== runtime) return;
    // Resolve again at activation, so a moved session never pins its old directory.
    const target = useGlobalSessionsStore.getState().entityById.get(sessionId);
    const targetDirectory = target ? resolveGlobalSessionDirectory(target) : sessionDirectory;
    if (targetDirectory) useSessionPinnedStore.getState().toggle({ directory: targetDirectory, sessionId });
  }}>
    <Icon name="pushpin" className="mr-1 size-4" />
    {t(pinned ? 'header.sessionTabs.unpinSidebar' : 'header.sessionTabs.pinSidebar')}
  </Item>;
}

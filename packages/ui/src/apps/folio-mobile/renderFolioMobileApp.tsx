import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/fonts';
import '@/styles/katex-css';
import '@/index.css';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { DiffWorkerProvider } from '@/contexts/DiffWorkerProvider';
import type { RuntimeAPIs } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { prepareMobileRuntime } from '../renderMobileApp';
import { FolioMobileApp } from './FolioMobileApp';

/** Boots the Folio iPhone app: local notes plus the OpenChamber mobile chat UI for the Mac's chats. */
export function renderFolioMobileApp(apis: RuntimeAPIs) {
  const resolved = prepareMobileRuntime(apis);
  const root = document.getElementById('root');
  if (!root) throw new Error('Root element not found');
  createRoot(root).render(
    <StrictMode>
      <I18nProvider>
        <ThemeSystemProvider>
          <ThemeProvider>
            <DiffWorkerProvider>
              <FolioMobileApp apis={resolved} />
            </DiffWorkerProvider>
          </ThemeProvider>
        </ThemeSystemProvider>
      </I18nProvider>
    </StrictMode>,
  );
}

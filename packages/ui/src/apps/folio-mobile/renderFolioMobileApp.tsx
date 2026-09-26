import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/fonts';
import '@/index.css';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { initializeLocale, I18nProvider } from '@/lib/i18n';
import { getDeviceInfo } from '@/lib/device';
import { FolioMobileApp } from './FolioMobileApp';

/** Boots the standalone iPhone Folio app. It never contacts an OpenChamber server. */
export function renderFolioMobileApp() {
  window.__OPENCHAMBER_SURFACE__ = 'mobile';
  initializeLocale();
  getDeviceInfo();
  const root = document.getElementById('root');
  if (!root) throw new Error('Root element not found');
  createRoot(root).render(
    <StrictMode>
      <I18nProvider>
        <ThemeSystemProvider>
          <ThemeProvider>
            <FolioMobileApp />
          </ThemeProvider>
        </ThemeSystemProvider>
      </I18nProvider>
    </StrictMode>,
  );
}

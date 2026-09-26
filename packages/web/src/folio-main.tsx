import { createConfiguredWebAPIs } from './runtimeConfig';
import '@openchamber/ui/index.css';
import '@openchamber/ui/styles/fonts';
import '@openchamber/ui/styles/katex-css';

// Folio for iPhone: notes on the phone, plus the same chat UI as the OpenChamber mobile app
// for the Mac's chats. The runtime APIs are the mobile ones, pointed at whichever Mac you connect.
window.__OPENCHAMBER_RUNTIME_APIS__ = createConfiguredWebAPIs();

void import('@openchamber/ui/apps/folio-mobile/renderFolioMobileApp')
  .then(({ renderFolioMobileApp }) => renderFolioMobileApp(window.__OPENCHAMBER_RUNTIME_APIS__ ?? createConfiguredWebAPIs()));

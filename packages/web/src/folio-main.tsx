import '@openchamber/ui/index.css';
import '@openchamber/ui/styles/fonts';

// Standalone iPhone Folio: notes on the phone and chat straight to AI providers, no server.
void import('@openchamber/ui/apps/folio-mobile/renderFolioMobileApp').then(({ renderFolioMobileApp }) => renderFolioMobileApp());

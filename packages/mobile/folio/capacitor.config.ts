import type { CapacitorConfig } from '@capacitor/cli';

// Standalone Folio for iPhone: bundles the folio.html surface and never needs a server.
// No push notifications or app extensions, so it can be signed with a free Apple ID.
const config: CapacitorConfig = {
  appId: 'com.carterlaborde.folio',
  appName: 'Folio',
  webDir: 'dist',
  ios: { contentInset: 'never', limitsNavigationsToAppBoundDomains: false },
  plugins: {
    Keyboard: { resize: 'native', resizeOnFullScreen: true },
    StatusBar: { overlaysWebView: true, style: 'DEFAULT' },
  },
};

export default config;

const WEBSITE_ORIGINS = new Map([
  ['persist:open-carter-muse', 'https://muse.ai'],
  ['persist:open-carter-claude', 'https://claude.ai'],
  ['open-carter-teaching', ''],
]);

export function setTeachingOrigin(origin) {
  const url = new URL(origin);
  if (url.origin !== origin || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Invalid teaching origin');
  WEBSITE_ORIGINS.set('open-carter-teaching', origin);
}

/** The browser-panel session and its controller are deliberately not included. */
export const hardenWebsiteSessions = (fromPartition) => {
  for (const partition of WEBSITE_ORIGINS.keys()) {
    const websiteSession = fromPartition(partition);
    websiteSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    websiteSession.setPermissionCheckHandler(() => false);
    websiteSession.setDevicePermissionHandler(() => false);
  }
};

/** Called before Electron creates the guest, not after an untrusted preload ran. */
export const secureWebsiteAttachment = ({ event, webPreferences, params, localParent }) => {
  const origin = WEBSITE_ORIGINS.get(params.partition);
  const preferenceOrigin = WEBSITE_ORIGINS.get(webPreferences.partition);
  if (!WEBSITE_ORIGINS.has(params.partition) && !WEBSITE_ORIGINS.has(webPreferences.partition)) return;
  let officialSource = false;
  try {
    const url = new URL(params.src);
    officialSource = url.origin === origin && !url.username && !url.password;
  } catch {
    // Invalid sources never attach to a persistent account partition.
  }
  if (!localParent || !officialSource || (preferenceOrigin && preferenceOrigin !== origin)) {
    event.preventDefault();
    return;
  }
  delete webPreferences.preload;
  delete webPreferences.preloadURL;
  delete webPreferences.session;
  webPreferences.partition = params.partition;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInWorker = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  webPreferences.webviewTag = false;
};

const WEBSITE_ORIGINS = new Map([
  ['persist:open-carter-claude', 'https://claude.ai'],
  ['persist:open-carter-venice', 'https://venice.ai'],
  ['persist:open-carter-gemini', 'https://gemini.google.com'],
  ['open-carter-teaching', ''],
]);

export function setTeachingOrigin(origin) {
  const url = new URL(origin);
  if (url.origin !== origin || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Invalid teaching origin');
  WEBSITE_ORIGINS.set('open-carter-teaching', origin);
}

/** The browser-panel session and its controller are deliberately not included. */
export const hardenWebsiteSessions = (fromPartition, enterpriseBlocked = () => false) => {
  for (const partition of WEBSITE_ORIGINS.keys()) {
    const websiteSession = fromPartition(partition);
    if (partition === 'persist:open-carter-gemini' && websiteSession.getUserAgent && websiteSession.setUserAgent) {
      // Keep the real Chromium/platform versions. Shell product tokens can
      // make browser-compatible pages choose an unsupported embedded-app path.
      const current = websiteSession.getUserAgent();
      const browser = current.replace(/\s(?:Electron|Open[- ]?Carter|OpenChamber(?:[- ]?Personal)?|openchamber-electron)\/[\w.+-]+/gi, '');
      if (browser !== current) websiteSession.setUserAgent(browser);
    }
    const mayPersist = (permission, rawUrl) => {
      if (partition !== 'persist:open-carter-venice' || permission !== 'persistent-storage' || enterpriseBlocked()) return false;
      try { return new URL(rawUrl).origin === 'https://venice.ai'; } catch { return false; }
    };
    websiteSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(mayPersist(permission, details?.requestingUrl || contents?.getURL() || '')));
    websiteSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => mayPersist(permission, requestingOrigin));
    websiteSession.setDevicePermissionHandler(() => false);
    if (['persist:open-carter-venice', 'persist:open-carter-gemini'].includes(partition)) websiteSession.webRequest.onBeforeRequest((_request, callback) => callback({ cancel: enterpriseBlocked() }));
  }
};

/** Called before Electron creates the guest, not after an untrusted preload ran. */
export const secureWebsiteAttachment = ({ event, webPreferences, params, localParent, enterpriseBlocked = false }) => {
  if (['persist:open-carter-venice', 'persist:open-carter-gemini'].includes(params.partition) && enterpriseBlocked) { event.preventDefault(); return; }
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

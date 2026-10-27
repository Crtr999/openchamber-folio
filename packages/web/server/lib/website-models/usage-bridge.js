/** Lets the quota system ask the website-account worker for a provider's usage
 * without importing the runtime. The runtime registers itself when enabled.
 */
let requester = null;
export const setWebsiteUsageRequester = fn => { requester = typeof fn === 'function' ? fn : null; };
export const websiteUsageAvailable = () => requester !== null;
export const requestWebsiteUsage = provider => {
  if (!requester) return Promise.reject(new Error('Website accounts are available only in the desktop app.'));
  return requester(provider);
};

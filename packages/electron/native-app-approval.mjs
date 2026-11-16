import { z } from 'zod';

const scopeSchema = z.object({
  directory: z.string().min(1), providerID: z.string().min(1), providerBinding: z.string().regex(/^[a-f0-9]{64}$/),
  runtimeId: z.string().min(1), app: z.enum(['calendar', 'reminders']), containerId: z.string().min(1).max(1024),
  runtimeEndpoint: z.url(),
  purpose: z.enum(['grant', 'containers']),
}).strict();

/** Native user click is the approval, never a boolean supplied by the tool caller. */
export function createNativeAppApproval({ getOwner, isLocalOwner, showMessageBox }) {
  let pending = false;
  return async (input) => {
    const scope = scopeSchema.parse(input);
    const owner = getOwner();
    if (!owner || !isLocalOwner(owner)) return { decision: 'unavailable' };
    if (pending) return { decision: 'busy' };
    pending = true;
    try {
      const result = await showMessageBox(owner, {
        type: 'question', title: 'Allow background app reads?',
        message: scope.purpose === 'containers'
          ? `Show ${scope.app === 'calendar' ? 'calendar' : 'reminder-list'} names and identifiers to this conversation?`
          : `Allow read-only ${scope.app === 'calendar' ? 'Calendar' : 'Reminders'} access for this conversation folder?`,
        detail: `Folder: ${JSON.stringify(scope.directory)}\nProvider: ${JSON.stringify(scope.providerID)}\nProvider configuration: ${scope.providerBinding.slice(0, 12)}\nRuntime: ${JSON.stringify(scope.runtimeEndpoint)}\nContainer ID: ${JSON.stringify(scope.containerId)}\n\n${scope.purpose === 'containers'
          ? 'This one-time operation returns only container names and IDs so you can select one. It reads no event or reminder content, creates no ongoing grant, activates no app and requests no OS access.'
          : 'Approve only an existing calendar or reminder list you selected yourself. This grants reads of this container to this folder and provider on this running desktop host. No app is activated and no OS access is requested. Each read still requires an explicit user request. Access expires when this host restarts or the provider configuration changes.'}`,
        buttons: scope.purpose === 'containers' ? ['Cancel', 'Show container names'] : ['Cancel', 'Allow read-only access', 'Revoke access'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (getOwner() !== owner || !isLocalOwner(owner)) return { decision: 'unavailable' };
      return { decision: result.response === 1 ? 'approved' : result.response === 2 && scope.purpose === 'grant' ? 'revoked' : 'cancelled' };
    } finally { pending = false; }
  };
}

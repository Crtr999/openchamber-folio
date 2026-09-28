import type { PermissionRuleset } from '@/lib/opencode/model';

/**
 * The agent and the tool set a page conversation runs on.
 *
 * Ask AI used to send on whatever agent the ordinary chat beside it was on, so
 * asking a question about a page handed the question to a coding worker: it read
 * its memory file, ran `shell` looking for the source, and answered about the
 * repository instead of the page. The model was already moved out of the global
 * config for the same reason, and the agent is the same defect. Both live here,
 * in Folio's own module, and nothing in this file reads global chat state.
 *
 * The agent itself is defined where it has to be to exist: OpenChamber publishes
 * it into the managed OpenCode config wherever the notebook is hosted, next to
 * the `folio` tool it uses
 * (`packages/web/server/lib/opencode/folio-ask-agent.js`). OpenCode fails a
 * turn whose session names an agent it cannot resolve, so the id here and there
 * are one contract and neither side may rename it alone.
 */
export const FOLIO_ASK_AGENT = 'folio-ask';

/**
 * What a page conversation is allowed to do, in the order OpenCode evaluates
 * them: the last matching rule wins, and the ruleset is appended after the
 * agent's own, so a conversation's tool set is bound to the conversation.
 *
 * The catch-all deny is what makes this a notebook conversation rather than a
 * worker. Every built-in tool asserts a permission before it runs, so `bash`,
 * `read`, `write`, `edit`, `glob`, `grep` and the rest fail with "Permission
 * denied" instead of being merely discouraged. `folio` and `openchamber` are
 * OpenChamber plugin tools, which do not assert; they are named because the
 * ruleset is also the honest record of what this conversation may reach.
 */
export const FOLIO_ASK_PERMISSIONS: PermissionRuleset = [
  { action: '*', resource: '*', effect: 'deny' },
  { action: 'folio', resource: '*', effect: 'allow' },
  { action: 'openchamber', resource: '*', effect: 'allow' },
];

/**
 * The agent Folio's in-page Ask AI runs on.
 *
 * The panel beside a notebook page is a conversation about that page, not a
 * coding session, so it needs an agent whose instructions say so and whose tool
 * set is the notebook. It is published through the managed config layer next to
 * the `folio` tool it uses, and only where the desktop app hosts the notebook:
 * the same gate as the tool, because an agent that can call a tool this install
 * does not have would answer every question with a permission error.
 *
 * It is `hidden` on purpose. Ask AI names the agent itself; the agent has no
 * business in the agent picker beside the user's own coding agents, and OpenCode
 * never picks a hidden agent as a default.
 *
 * `packages/ui/src/lib/folio/ask-agent.ts` names the same id on the send path.
 */

/** The id a page conversation is created on and sends with. */
export const FOLIO_ASK_AGENT_ID = 'folio-ask';

/**
 * The agent's ruleset, in the order OpenCode evaluates them: last match wins,
 * and the session's own rules are appended after these, so a page conversation
 * cannot be widened by the agent definition either.
 *
 * The catch-all deny is what makes this a notebook conversation rather than a
 * worker: a built-in tool that asserts a permission this ruleset does not allow
 * fails with "Permission denied", so a shell command or a file read is not
 * merely discouraged, it cannot run. The `folio` and `openchamber` tools are
 * OpenChamber plugin tools, which do not assert, and are named here because the
 * ruleset is also the honest description of what this agent may do.
 */
const FOLIO_ASK_AGENT_PERMISSIONS = [
  { action: '*', resource: '*', effect: 'deny' },
  { action: 'folio', resource: '*', effect: 'allow' },
  { action: 'openchamber', resource: '*', effect: 'allow' },
];

const FOLIO_ASK_AGENT_SYSTEM = `You answer questions about one page of the user's Folio notebook.

The page is sent to you in full with each question, so the answer is already in front of you: read it and answer from it. There is nowhere else to look. This conversation has no project, no files and no commands, and the notebook is not stored in this conversation's folder, so searching for it cannot succeed and guessing at it is worse than saying what the page says.

Use the folio tool only when the answer needs a page that is not in front of you: a page the user @mentions, or a page you have to change. Read a page with folio.read before you edit it, edit only what the user asked for, and use the block and row ids that read returns. A page the user excluded from AI can be neither read nor changed; say that instead of guessing what it said. Use the openchamber tool only to read a conversation the user @mentions.

Answer in the language the question is written in. Be as short as the question deserves, and leave out the preamble: no restating the question, no describing what you are about to do, no offering further work. When the page does not answer the question, say what it does say about the subject rather than filling the gap.`;

/**
 * The `agents` entry this install publishes into the managed OpenCode config.
 *
 * @returns {{ description: string, mode: 'primary', hidden: boolean, system: string, permissions: typeof FOLIO_ASK_AGENT_PERMISSIONS }}
 */
export function folioAskAgentDefinition() {
  return {
    description: 'Answers questions about the Folio notebook page in front of the user.',
    mode: 'primary',
    hidden: true,
    system: FOLIO_ASK_AGENT_SYSTEM,
    permissions: FOLIO_ASK_AGENT_PERMISSIONS.map((rule) => ({ ...rule })),
  };
}

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

The page is sent to you in full with each question, so the answer is already in front of you: read it and answer from it. Beyond that, the notebook is a full page tree you can explore:
- folio.search to find pages by title or content
- folio.list to see what pages exist, optionally inside a parent page
- folio.read to read a page's content and, for a database, its columns, rows and views

When the user asks about or to change something that is not the current page, find it first with folio.search or folio.list, then folio.read it to get its block and row ids before editing.

You have the folio tool for editing notes and databases. Use it when the user asks you to change something:
- folio.update_block to change a block's text
- folio.append / folio.insert to add content
- folio.rename to rename a page
- folio.create to make a new page
- folio.add_row / folio.update_row / folio.delete_row for database rows
- folio.set_view to change a database's layout (table, board, gallery/card, list, chart)
- folio.delete_block to remove a block

Edits appear on the user's screen immediately. When the user says to fix or change something, use the tool rather than saying you cannot. Edit only what the user asked for.

A page the user excluded from AI can be neither read nor changed; say that instead of guessing what it said. Use the openchamber tool only to read a conversation the user @mentions.

There is no project, no filesystem, no code to search here. The notebook is not stored in this conversation's folder. But the notebook itself is fully explorable with the folio tool.

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

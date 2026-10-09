# Account history and scheduled task integration

Checked October 8, 2026. Pinning is implemented. Automatic Claude/Muse account
history and external scheduled-task feeds are not implemented.

## What the app actually owns

`lib/chatgpt/native.ts` opens an ordinary OpenCode project and selects the OpenAI
provider. OpenCode owns those native sessions and their transcripts. This is not
an adapter for chatgpt.com account history, memory or scheduled tasks.

`ChatGPTWorkspace` is separate. Its origin-gated, app-owned DOM script reads only
the loaded website sidebar's titles, paths and profile display metadata through
the retained guest's `executeJavaScript`. It does not query a native account API.
The list is partial website navigation. Its profile display string is not proof
of an immutable account or Team/personal workspace identity, so do not reuse it
as the identity contract for a new provider adapter.

Claude and Muse currently publish only observed navigation URL/title events to
their stores. Their saved-page arrays are explicitly local links and survive
account changes. They are neither account history nor native conversations.
`website-guest-security.mjs` isolates their persistent sign-in sessions from the
general browser controller and strips guest preload privileges. The app-owned
ChatGPT script demonstrates that a constrained metadata adapter is possible;
the isolation rules do not justify exposing arbitrary scripts or account tokens
to agents.

The installed macOS app had a working accessibility window and nested app groups.
Only the backend TCP listener was present, with no existing debug listener.
Accessibility traversal of the changing native chat tree failed and then timed
out. No signed-in Claude or Muse navigation DOM, account/workspace identifiers,
conversation URL rules or scheduled job metadata were verified. No message bodies,
cookies, tokens or website application stores were read. No debug port or browser
partition access was enabled to bypass the guest boundary.

## Supported provider paths

| Provider | Official evidence | What it permits here |
| --- | --- | --- |
| ChatGPT | [Scheduled tasks](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt) documents one-off, recurring and monitoring tasks, eligible app-event triggers, and task sharing. It includes tasks in compliance coverage but excludes scheduled tasks from personal data exports. | The website owns these jobs. No public personal-account job-list API was verified. A shared task link is a saved snapshot, not a live inventory or next-run feed. |
| OpenAI compliance | [Compliance Platform](https://help.openai.com/en/articles/9261474-compliance-api-for-enterprise-customers) requires an Enterprise/Edu workspace and workspace-scoped Admin key with approved permissions. | A separate organization integration may be possible after workspace-owner authorization and schema review. An OpenAI inference key or subscription connection does not grant this access. |
| Claude | [Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork) documents cloud sessions and cloud scheduled tasks. [Routines](https://code.claude.com/docs/en/routines) documents Claude Code schedules and a per-routine `/fire` API. | `/fire` starts a routine. It does not enumerate schedules, list chats, or supply a read-only account feed. Wiring it into Open Carter's local Run now control would run a remote job, not mirror its status. Nothing calls it. |
| Claude compliance | [Compliance API](https://platform.claude.com/docs/en/manage-claude/compliance-api) and [access setup](https://platform.claude.com/docs/en/manage-claude/compliance-api-access) document Enterprise chat/session access through an owner-provisioned Compliance Access Key. Console Admin keys reach only the Activity Feed. | This is a real organization API, not access granted by a Team subscription, consumer login, ordinary inference key or analytics key. A read-only integration needs an authorized organization, the required scopes and a verified metadata contract. |
| Claude native inference | [Authentication policy](https://code.claude.com/docs/en/legal-and-compliance) permits end-user sign-in to the unmodified official Claude Code binary, but prohibits third-party token collection/intermediation. [OpenCode V2 providers](https://opencode.ai/v2/docs/providers) documents Anthropic inference, not subscription account-history access. | Official Claude Code is an independent runtime. Neither substituting API billing nor replaying subscription tokens would preserve the requested website account history and memory. |
| Muse | [Product design](https://introducing.muse.ai/) documents a main chat, side chats, Goals, and scheduled/event-driven background work. [Security design](https://security.muse.ai/) identifies the user's Secure VM as its system of record. | No supported personal-account history/job-feed API was verified. Muse does have background scheduling; lack of a feed is not lack of the feature. |
| Meta developer products | [Muse Code](https://developer.meta.com/ai/products/muse-code) describes a separate coding subscription and Meta Model API. [Muse Connector Platform](https://muse.ai/platform) and its [public guidelines](https://muse.ai/platform/docs) accept API/MCP connectors for Muse to use outside services. | This direction matters. Muse connects to the developer's service; the guidelines do not expose a read API for a user's Muse chats, goals or schedules. Model inference and connectors are not account-history parity. |

The public Muse Platform pages returned HTTP 200. The Markdown fetcher produced
no text, so their public HTML was inspected without login or credentials. The
guidelines require a submitted service endpoint, API/MCP tool documentation,
auth/scopes, business verification, privacy review, a test account and end-to-end
QA. They support read-only connectors when the information is the outcome, but
reject a public-page wrapper or link list alone. This could support a future
Open Carter service connector that Muse explicitly calls. It does not authorize
pulling Muse's own history or scheduled jobs into Open Carter. Public `/api`
and `/developers` requests returned HTTP 401 and provided no API specification.

## What would unblock a website metadata adapter

First inspect navigation-only metadata inside the actual signed-in, trusted local
guest with the user's approval. Verify sidebar containers, exact observed links,
titles, loading and signed-out states, and an authoritative account plus selected
workspace identity. Email or a profile label alone cannot distinguish personal
and Team workspaces. If identity cannot be verified, fail closed rather than merge
inventories across accounts.

An app-owned adapter may then enumerate only loaded sidebar links, validate its
result at the boundary, label partial history accurately, and navigate exact
observed URLs in the same guest. Read only whitelisted navigation attributes and
text. Preserve previous same-scope data on read failure, reject stale completions,
and clear scoped projections immediately on verified account/workspace changes.
This gives genuine sidebar access to website threads, not native transcript sync.
Native reply/history/memory parity needs a separately supported provider contract.

## External scheduled rows

`SidebarScheduledSection` currently reads only Open Carter project task APIs.
The server scheduler creates OpenCode sessions. It neither owns nor executes
ChatGPT, Claude or Muse account jobs.

An external row requires a verified provider job ID, title, exact deep link,
schedule dates with timezone, status, account/workspace scope and read result.
Keep source-specific identities separate from local project/task IDs. Unknown
next-run dates stay unknown. Stale/failing feeds are not authoritative empty
lists. External rows must be read-only, with no inherited local Run now,
pause or delete controls. Local schedule definitions must never be created from
external rows because that would risk running the same work twice.

No current personal-account feed meets those requirements. The concrete next
choices are a verified guest navigation/task metadata contract, or an explicitly
authorized Enterprise compliance integration after checking whether its task
schema supplies current jobs rather than historical audit events. Neither
requires weakening the existing browser-controller partition restriction.

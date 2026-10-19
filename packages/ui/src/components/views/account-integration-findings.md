# Account history and scheduled task integration

Checked October 18, 2026. Pinning is implemented. Automatic Claude account
history is not implemented. One external scheduled-task feed is implemented: a
read-only mirror of Carter's own ChatGPT/Codex automations.

The automation reader and card component remain, but Home no longer mounts the
card or performs its reads. Carter requested its removal from Home. This does
not remove vendor jobs or change local Scheduled tasks.

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

Claude currently publishes only observed navigation URL/title events to
its store. Its saved-page array is explicitly local links and survives
account changes. They are neither account history nor native conversations.
`website-guest-security.mjs` isolates its persistent sign-in session from the
general browser controller and strips guest preload privileges. The app-owned
ChatGPT script demonstrates that a constrained metadata adapter is possible;
the isolation rules do not justify exposing arbitrary scripts or account tokens
to agents.

The installed macOS app had a working accessibility window and nested app groups.
Only the backend TCP listener was present, with no existing debug listener.
Accessibility traversal of the changing native chat tree failed and then timed
out. No signed-in Claude navigation DOM, account/workspace identifiers,
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
ChatGPT or Claude account jobs.

An external row requires a verified provider job ID, title, exact deep link,
schedule dates with timezone, status, account/workspace scope and read result.
Keep source-specific identities separate from local project/task IDs. Unknown
next-run dates stay unknown. Stale/failing feeds are not authoritative empty
lists. External rows must be read-only, with no inherited local Run now,
pause or delete controls. Local schedule definitions must never be created from
external rows because that would risk running the same work twice.

## The ChatGPT automations feed

`~/.codex/automations/<id>/automation.toml` is the one feed that now meets those
requirements. It is Carter's own machine state written by the ChatGPT/Codex
desktop app, not an account API: version, id, kind, name, status, rrule,
target_thread_id, created_at, updated_at and prompt. `HomeChatGPTTasks` reads it
through `chatgpt-automations.mjs` on the trusted local main-frame boundary.

It satisfies the bar except for two points that are reported rather than faked:

- **No deep link.** No ChatGPT/Codex thread URL scheme was verified, so the card
  shows `target_thread_id` as text and derives no `chatgpt.com` URL.
- **No account scope.** These files carry no account or workspace identity. The
  feed is scoped to the Mac it was read from, and nothing here proves which
  ChatGPT account owns the job.

Everything else is honest about its source. The rrule is summarized only where
the reader can place the next run; `FREQ=MONTHLY`, `COUNT`, `UNTIL`, an ordinal
`BYDAY`, an out-of-range `BYHOUR` and any other unmodelled rule display an
explicit unknown instead of a guess, and a daily rule that states no time of day
shows its cadence with an unknown next run. Times are placed in the Mac's local
zone, which is the only zone these files refer to. A strict line-oriented reader
covers the flat `key = "value"` subset and quarantines anything it cannot read
with confidence; the card then says how many files were unreadable. A missing
`~/.codex/automations` is an explicit empty feed, and any other read failure
keeps the last good rows beside an explicit error.

The rows are read-only in the strict sense: nothing is written under `~/.codex`,
no task is created, edited, paused, resumed, deleted or run, and an external row
never becomes a local Open Carter schedule. ChatGPT automation ids stay in
`providerJobId`/`providerThreadId` and are never merged with local project or
task ids.

Whether the ChatGPT Mac app is installed, signed in or running is a separate
concern from this feed. The folder exists whether or not the app is open, and the
card does not detect, launch or control the app. The jobs are executed by the
ChatGPT app's own scheduler, so closing the app stops them; a ChatGPT message
that the Mac is offline in that state comes from ChatGPT itself, never from Open
Carter.

The remaining unblocked choices are a verified guest navigation/task metadata
contract, or an explicitly authorized Enterprise compliance integration after
checking whether its task schema supplies current jobs rather than historical
audit events. Neither requires weakening the existing browser-controller
partition restriction.

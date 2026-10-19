# Notion intake through the shared team

Pass the server's existing team authority as the optional `team` dependency of
`createAiTaskRuntime`. Keep the legacy executor injected for project listing,
assignment validation, and historical run inspection. Do not create another team
runtime, executor, polling loop, provider selector, or usage budget for Notion.

The injected team contract is:

```ts
send({ projectId, title, text, requestId }): Promise<TeamRun>
details({ projectId, teammateId }): Promise<{
  teammate: Teammate; runs: TeamRun[]; routines: TeamRoutine[];
}>
getRun({ projectId, requestId }): Promise<TeamRun | null>
```

`getRun` is lookup only. It uses the same project-scoped request identity as
`send`, and returns `null` only after a successful authoritative lookup confirms
no durable run. Read failures must throw. It must not create, dispatch, inspect,
or resend work. The shared owner retains its durable run before dispatch.

The coordinator claims and reads an assigned Ready card as before. It saves
`teamRequestId = notion:<Notion run ID>` and running tracking before calling
`team.send` exactly once. The returned shared identity supplies `teamRunId`,
`teammateId`, `sessionId`, `directory`, and `teamRevision`. Team details supply
the project label and agent. A lost send response is recovered by request lookup,
never a repeated send. Missing shared tracking goes to Needs you without claiming
that no prompt was sent. Lookup failure preserves tracking for another read.

The server continues to poll `team.check`. The Notion coordinator only reads the
shared durable phase, final content, diagnostics, and actual children. It never
calls the legacy executor for a shared run. Shared concurrency, observed lifetime
usage, and provider rules therefore cover direct and Notion dispatch together.
Queued, creating, dispatching, and running shared phases remain Doing. Done becomes
a Done writeback; Needs you and paused become Needs you writebacks. Shared failure
stages are preserved, including resolve, pause, and stall.

Once a result is saved for writeback, its content and shared revision are frozen.
Only the same result is retried, because Notion's append marker is the Notion run
ID. A later shared revision or separate direct revision does not replace a result
whose append may already have succeeded. Moving a card back to Ready authorizes a
new intake and a new append marker. Membership and Doing checks still belong to
the approved Notion adapter. User moves away cancel automatic writeback.

Runs without `teamRequestId` remain legacy runs even when injection is enabled.
They inspect their recorded executor/session/directory and never redispatch.
Without injection, new runs keep the previous legacy behavior. Removing injection
does not convert existing shared runs into legacy work; their reads fail closed.

Electron uses its approved encrypted Notion adapter. Web hosts require an approved
injected adapter. VS Code, hosted mobile, and Capacitor still have no native Notion
setup. Enterprise refusal remains at the coordinator and Notion adapter boundaries.
Closing the Notion coordinator never closes the shared authority.

## Notes saves and prior results

The desktop notes editor edits the brief before the first generated
`## Open Carter run <id>` heading. Later result sections stay on the page,
are preserved when notes change, and never become the next manager's brief.
A matching heading inside fenced code remains part of the brief.

A clean hosted Notion `update_content` acknowledgement confirms a notes save.
Do not require a byte-equivalent markdown readback: Notion can rewrite paragraphs,
links, list numbering and tables without changing the saved content. Parser warnings
still fail the save and prevent handoff. A lost acknowledgement is recovered only
when a complete read matches the requested brief and preserved results. Otherwise
the error remains and the editor keeps its draft; the adapter never repeats a write
to resolve an ambiguous response. No-op and ambiguous-write comparisons preserve
word boundaries, indentation and literal inline or fenced code, while accepting Notion empty
blocks, escaped text and line-break tags outside code.
An authoritatively empty task page can be initialized with `replace_content`;
non-empty pages continue to use the exact current body as the update anchor.
An unclosed code fence is refused before writing so later result headings cannot
become code and disappear from the editable-brief boundary.

This changes only local Electron notes behavior. Web still needs an approved
injected adapter; VS Code, hosted mobile, Capacitor and remote desktop gain no
native Notion access. Existing enterprise and local-frame gates remain unchanged.

## Confirmed card trash

`deleteAiTask(page): Promise<{ saved: true }>` is the shared desktop client action.
The confirmation UI calls it only after confirmation. Native receives
`ai-delete` with `confirmed: true`; missing or false consent fails before Notion
requests. Daily To-Do's delete action now carries the same confirmation flag.

The coordinator serializes deletion with pickup and reconciliation. Claimed,
running and pending-result runs deny deletion even if someone moved the card
out of Doing. Retained shared runs require a successful authoritative lookup,
a terminal shared phase and no `pausePending` barrier. Missing authority refuses.
The adapter independently re-fetches source schema, a complete unfiltered saved
view and page membership, and refuses Doing cards before the trash operation.

The hosted connection's advertised tool schema decides singular `page_id` or
plural `page_ids` and the `data` wrapper. Advertised boolean confirmation fields
receive the explicit consent. Unsupported required parameters refuse instead of
being guessed. No permanent-delete parameter is synthesized. Actual hosted schema
compatibility remains unverified without a live approved connection.

Confirmed trash removes the future folder assignment, not saved runs, output or
linked chats. Notion failure preserves local tracking. An acknowledgement lost
after trash never triggers an automatic repeated delete. Other native runtimes
remain unsupported; injected web adapters must explicitly supply this capability.

## Referenced Notion notes

Before any provider dispatch, `automation.readTask` resolves explicit official
Notion page URLs in the original notes through the same encrypted hosted
connection. Supported hosts are `notion.so`, `www.notion.so`, `app.notion.com`,
`notion.com` and `www.notion.com`. Browser routes such as
`https://app.notion.com/p/name/Full-Tech-Stack-<page-id>` canonicalize to
`https://www.notion.so/<page-id>` for hosted fetch, and the fetched page ID must
match. The original notes keep their browser URL. No arbitrary URL is fetched by
the host. Published `notion.site` and unsupported Notion subdomains fail explicitly
and require an official workspace page link.

A title with a location also requests resolution, for example
`Legal Pro in the Villanova Law Dashboard, Assignment 1` or
`Use the Notion note called "Legal Pro" in the Villanova Law Dashboard, Assignment 1`.
Only that exact title is searched with internal search. Each returned candidate
is fetched and checked against its actual title and ancestor path. Slash or `>`
paths must match the fetched ancestor-path suffix. A unique verified match is
required. Missing pagination completeness, broad search, duplicate matches,
missing sources or unreadable metadata fail explicitly and ask for the exact URL.
Title-only requests and ordinary notes remain normal briefs without source search.

The manager receives the unchanged notes followed by a separate reference-data
section with the fetched source title, official URL, requested Assignment selector
and complete content. Prior generated run sections remain excluded. Source text is
data, not new permission, and the resolver never changes the note. Nested enhanced
Markdown child pages require verified parent identity and location. Limits are
four explicit sources, twelve search candidates, eight pages per source, two child
levels, 120,000 characters total and 120,000 characters per fetched response.
Truncated, unavailable, cyclic or over-limit child context fails rather than
silently supplying a partial source.

Reference failures retain static `notion_reference_*` diagnostics at `read-task`,
go to Needs you without a task prompt and never redispatch automatically. Raw
remote errors and source text do not enter diagnostics. Editing the original
notes remains available after the run settles. Reauthorizing Ready is explicit.

The resolver does not choose a model, project or consent setting. The assignment's
chosen provider and existing policy still govern dispatch; nothing silently moves
source content to All Chats or a free model. A coursework title containing "Legal"
is not evidence of confidential client material. Users must choose an appropriate
approved destination for sensitive material. Enterprise refusal still applies to
every hosted request. No workspace-wide index or background reference scan exists.

## Loading request counts

The exact public `automation.readBoard` fixture was measured before the change.
It has one complete saved-view page, all six AI statuses, stateless MCP setup and
the same authenticated connection across calls. Cold, immediate warm and two
simultaneous warm board reads issued 8, 4 and 8 hosted requests. The changed path
issues 8, 2 and 2. Assertions count actual fake-hosted requests and verify delivered
rows, so a disabled query cannot appear as an improvement. A denied query makes
7 cold requests and 3 on retry, returns failure, and is never cached as empty.

The multiplying cost was callers × source metadata fetches plus live view and row
requests. Read-only source metadata shares at most four in-flight or successful
entries for fifteen seconds, at most 1 MiB each, scoped to the native connection.
Concurrent board callers share the complete in-flight read. Tokens, reconnect,
disconnect and configuration changes invalidate reuse; failed metadata or board
reads clear entries. Oversized metadata is not retained. Every saved-view
configuration and every row page still loads live. All mutations, habits writes,
claim and writeback membership checks bypass metadata reuse. No board snapshot
or source content is persisted, and failures cannot authorize absence.

These are deterministic native network-operation counts, not measured installed
startup latency, rendering time or live Notion latency. HMR, packaged UI and live
hosted reference/deletion schema validation remain separate native QA.

# AI Tasks

Opt-in task coordination owned and started by the web server. Electron supplies
its encrypted Notion adapter through `startWebUiServer.aiTaskConnection`.
The controller exposes `getAiTasks()` to the local IPC bridge and drains the
coordinator before stopping OpenCode. A headless host can inject an approved
adapter through the same contract. No cloud credential adapter or deployment
is shipped yet. `runtime.js` owns claims, assignments, dispatch ordering, polling,
and results. `executor.js` uses the running OpenCode client, never a new service.

## Runtime availability

- Electron local desktop: Home offers a separate AI Tasks board and explicit setup.
- Web: coordinator work requires an explicitly injected approved adapter. No native Notion credentials or setup.
- VS Code: unsupported; no native connection or coordinator.
- Hosted mobile: no native board controls. Existing chats remain ordinary sessions.
- Capacitor mobile: same as hosted mobile.
- Remote desktop pages: no access to local connection or coordinator IPC.

## Contract

The database must be separate from Daily To-Do and have Idea, Ready for AI,
Doing, Done, Needs you, and Parked statuses. Setup validates this before enabling.
Moving a card to Ready for AI authorizes pickup in its explicitly selected folder.
Every 15 minutes, while the host is running and the coordinator is enabled, it
starts at most one assigned card. Unassigned cards stay inert. A manual
check can pick up sooner. There are no idle AI calls. SQL access may consume the
Notion workspace's query allowance; model usage follows the configured provider.

Claims and chat IDs are written before dispatch. Ambiguous sends never retry.
A claimed record after interruption goes to Needs you without sending a prompt.
Result write failures keep the result locally and retry only writeback. A unique
run marker in the card makes an already-applied content append recoverable.
Notion has no atomic compare-and-set for status. Membership and Doing status are
rechecked before writes, but another client may still move the card in that gap.

User moves away from Doing stop automatic writeback. Moving a finished/blocked
card back to Ready authorizes a fresh run. Tracking is retained, not silently
evicted. One active coordinator limits cost and overlap. Each run selects the
directory-scoped manager explicitly, honors its deny rules, and tightens allow
rules to ask. No permission auto-accept is enrolled. Only an available Explore
definition with a matching or inherited model and broad denials for mutation,
shell, execute, cross-session dispatch and delegation can be offered, with
approval. Other specialists are denied in this first slice. OpenCode provider
policies remain the provider lock. Prompt instructions alone are not isolation.

Done requires a successful session outcome, a completed stop answer beginning
DONE, and confirmed Notion content/status writes. A failed, interrupted, or
NEEDS YOU answer goes to Needs you. Approval waits remain visible in the linked
chat and stay Doing. Pausing prevents pickups while existing tasks reconcile.
Quitting stops polling; reopening resumes reconciliation, not redispatch.
Disconnected Notion and enterprise policy prevent all Notion requests and new
dispatch. Failures never become an empty successful board. Task descriptions go
to the chosen OpenCode provider, and final answers go to the connected Notion
workspace only after opt-in. No reasoning or tool output is exported.

New shared team runs also require the completion review described below. Historical
legacy sessions keep their original completion contract.

Assignments are stored per board and page, with a revision, and frozen into each
run. A project must still exist with an available directory, manager, model and
variant before creating its session. No standalone workspace is created and the
legacy board-wide `model` value is retained only for file compatibility, not used
for new runs. Old tracking files default to empty assignments; existing runs keep
their original directory and reconcile there. No card is automatically reassigned.
Folder assignments are local to this host, not yet mirrored into Notion.
Home retains each successful assignment acknowledgement until a later valid
status read replaces it. Send uses that acknowledgement while refresh is slow or
fails, so it cannot replace the chosen folder/model with an older snapshot.
Runtime changes clear these acknowledgements; old-host responses cannot add them
to the new host's cards.

Claims, page-content reads, creation, dispatch, inspection and writeback failures
retain a safe stage, code and timestamp. SDK HTTP statuses come from `cause.status`;
arbitrary messages, response bodies and credentials are not exported. A failed
claim that leaves a card Ready does not retry until its folder is explicitly
reassigned. A caught startup failure is saved immediately, not replaced by the
generic interruption text on the next poll. Writeback failure preserves the result
and the original failure, with a separate diagnostic cleared after writeback succeeds.

Every retained run has a details view, including old runs with no session ID.
It shows the saved result and diagnostic, and offers a chat link only with both
the recorded ID and directory. Direct child chats are cursor-paged from OpenCode
using that parent and directory, never inferred from prose. Wrong-scope results
fail closed. A child-history failure is distinct from empty history and does not
hide the saved parent chat or result. Nested descendants remain accessible in
the ordinary chat hierarchy. Details are read on opening, not continuously polled.

The Home widget commits local configuration/status before reading the Notion
board. Failed or slow board reads cannot disable setup or keep completed
mutations busy. Refresh is a read, not a mutation lock. Paused setup permits
clearing a broken board URL so the user can return to database creation; enabled
setup still requires a database. No existing Notion pages are deleted.

The server supplies authoritative project settings and waits for OpenCode readiness
before location-scoped model/agent reads. A missing default is a setup blocker,
never permission to choose the first catalog model or a different provider.

## Shared team intake and free-only execution

When the server supplies its existing team runtime, new Notion assignments use
that authority instead of a second executor. `NOTION_TEAM.md` defines recovery,
historical-run compatibility and frozen writeback results. The server creates the
team before the Notion coordinator and is the only owner of team polling.

Version 2 team policies select an exact model without changing ordinary project
defaults. Every dispatch rechecks all advertised pricing tiers and cache prices.
The host also requires an active `open-carter-free-team-guard` plugin with the exact
reviewed source and exact manager/child rules. `team-host-guard.js` verifies its
source digest and serialized profile arguments. Agent tools cannot edit plugins
or configuration. A changed source requires a reviewed digest update.

The guard checks model, HTTP and WebSocket dispatch, including auxiliary calls.
It follows actual parent records to identify tagged task descendants. Before
prompt admission and context generation, it applies that agent's exact scoped
rules through the pinned SDK's `session.update`. It never approves pending
permissions. Task titles reuse the existing title without a maintenance model;
ordinary chat titles and model defaults remain unchanged. A paid auxiliary model
or provider fallback refuses rather than switching or making a billable call.

The live runtime returns the explicit `default` variant for some models. This is
the normalized default selection, not permission to choose another variant.
Other variants remain refused. Catalog prices are provider reports, not proof of
account charges. A zero-priced catalog entry may still refuse a third-party host.
The host preserves that failure and never bypasses provider restrictions.

`TEAM_TOOLS.md` describes the bounded computation and create-only output modules.
They remain unavailable until host authorization and tool activation are proven.

## Per-card model choice

A version 2 policy may list reviewed alternatives in `models`. The policy `model`
stays the default. A card's assignment may name one of them; the run stores it and
every later check (manager, children, tool authorization, accounting) resolves the
same model. A choice outside the list refuses. Team agents must leave `model`
unpinned so children inherit the run's model; a child on any other model fails
inspection and the guard refuses its requests.

Every new shared run saves its normalized effective provider and model before
creating the manager session, even when intake omitted a model and used the
reviewed default. Explicit revisions inherit that saved choice. Routine proposals
freeze the reviewed model, and each occurrence saves it too. A changed or
unavailable choice refuses rather than using a new default. Replaying a request ID
with a conflicting explicit model refuses; replay without a model returns the
already-saved run without resolving defaults or sending again. Historical runs
without a saved model remain unchanged. An explicit card choice cannot use the
legacy coordinator when shared team execution is unavailable.

New version 2 manager sessions also record `metadata.aiTaskModel` alongside the
run ID at creation. That frozen choice lets the guard detect a later change to
the manager's live model instead of treating it as authority for every child.
Ordinary composer choices and fixed-provider project rules are not changed.

Alternatives must price at zero, except entries marked `billing: "subscription"`.
Those are flat-subscription providers, such as ChatGPT sign-in, whose catalog
lists no metered price. They are admitted only while the catalog entry stays
unpriced: any listed price means metered billing and refuses. A paused or expired
subscription fails the run; nothing falls back to another model.

`projects` lists each folder's currently valid models. Home shows the Ready for AI
status as "Send to manager"; moving a card there starts a check immediately. The
card's Notion page body is its brief: the manager receives the title as a heading
followed by every note on the page. Home edits that body through the card's Notes
dialog (`ai-notes` / `ai-save-notes`, refused while the card is Doing). Sending a
card with no notes opens Notes first; "Send title only" remains a valid quick
request, and the manager is told to interpret it and state its assumptions. New
cards get a prompt line, never an empty body, so result writeback always has an
anchor. Prompt lines are stripped before dispatch. Folders whose `projects` entry
has no valid models have no team and cannot be chosen.

The server always lists one built-in destination first, `openchamber:all-chats`
("No folder (All Chats)"). Its directory is the fixed team home `<chats root>/ai-team`,
so its manager and specialist chats appear in All Chats. It carries its own reviewed
team policy, agents, guard and tools like any project folder, and governs no
project's files. A card sent to the manager without a folder is assigned there when
that team is ready; otherwise the hand-off is refused as before. Chat cleanup never
deletes the team home, even when its last chat is deleted.

The manager brief inlines the destination's `AGENTS.md` and `MEMORY.md` (each up to
64 KiB, never through a symlink), so a manager does not stop for a read approval
before starting. A file that cannot be inlined is named, and the manager is told to
read it itself.

## Manager quality review

New team runs store `Completion contract: ai-task-review-v2.` at the beginning of
the existing `savedContext` brief field before dispatch. It survives restart and
ambiguous sends. Historical v1 runs retain their checklist contract. Runs without
a review marker retain their original completion contract. New assignments no longer receive the last three saved
results automatically. Only an explicitly authorized revision receives its named
source assignment and saved result.

The manager brief requires an acceptance checklist before delegation, actual
inspection of returned work and files, and specific correction requests to admitted
specialists. Corrections use the existing agent steps, permissions, token guardrails
and one-hour observation window. The host does not send correction prompts or retry
an ambiguous dispatch. Missing essential attachments, approvals or unresolved defects
must produce Needs you with partial work. Mentioning a filename is not file access.

A new successful answer contains a usable inline deliverable and exactly one final
`ai-task-review` fenced JSON block. It records `checks`, `files` and `limitations`.
Each check has a concrete `criterion`, an inspection `finding`, and `evidence`
entries containing an actual `sessionId` and an exact `quote` of 16 to 500 characters.
Historical v1 inline work may use an empty evidence list with an explained self-check.

The v2 contract additionally requires `audit` with a private draft excerpt, a real
independent reviewer child, one final `confirmed` verdict per check and a correction
record for every actual objection. Each check quotes the reviewer. The reviewer
must differ from the draft author. The child's actual user request must contain
the draft excerpt and exact check criteria, not merely a manager's claim that it
reviewed them. Draft and correction excerpts resolve to completed output before
the reviewer confirms them. Verdicts and correction resolutions quote the child's
latest successful stopped answer. Invented children, self-review, unmatched criteria,
unobserved corrections and old reviewer progress refuse completion. Every correction
request includes the actual prior objection and corrected author excerpt. When the
existing tools cannot continue a reviewer session, a fresh admitted child may verify
the corrected version and earlier objections. The runtime never sends that prompt.

The optional `audit.superseded` list permits a terminal abandoned failed or draft
child only with a specific reason, successful replacement excerpt and final
reviewer confirmation naming the abandoned child ID. The actual reviewer request
must contain that ID and replacement excerpt. Replacements cannot themselves be
superseded, and the final reviewer and draft author cannot be abandoned. Unknown,
active or unverified children still refuse. Current scope, provider, accounting
and receipt scans cover all children, including abandoned attempts. Historical v1
completion rules remain unchanged.

The manager requests adversarial claim-source, pinpoint, contrary-context,
calculation and requirement review, then corrects or defends actual objections
within existing tools, roles, step/token caps and deadline. Empty corrections are
valid only when no actual defects were found; the protocol does not require invented
defects. Missing review capability produces Needs you, never another provider,
paid fallback or automatic approval. All Chats peer review is not a ZDR or Legal
audit. Project-specific auditor, audit-log and proof-header requirements still apply.

The executor resolves excerpts against actual completed assistant messages or
nonempty completed tool results, excluding user requests and the final review itself.
It reads at most eight 100-message pages per referenced session. Every observed
child that is not explicitly superseded under v2 must have a successful stopped
final output quoted in the review. References to unknown sessions, old child
progress used as final proof, unresolved failed children or unavailable output refuse.
Claimed review files must appear in fresh byte-verified artifact receipts for this
run and be nonempty. The runtime passes fresh artifacts to inspection rather than
using retained historical receipts and requires a complete current receipt scan.
Bare DONE, missing review attestation and incomplete scans become Needs you without
another send. Authoritative read failures retain the existing bounded inspection
failure and pause behavior.

OpenCode reasoning parts may have opaque provider `state`. Only `type: tool`
parts are parsed for tool status and result content. Valid reasoning state cannot
fail the whole message inspection; malformed tool state still refuses. Runtime
inspection diagnostics identify accounting, children, evidence or result reads
and invalid responses or SDK HTTP status, without messages, response bodies or
task content. They retain the existing inspect stage and interruption threshold.

These checks establish review structure, independent child output and file provenance.
The minimum deliverable length is only a refusal of empty acknowledgements. Neither
that length nor a parsed checklist proves factual accuracy, complete requirement
coverage, source relevance, or that the manager performed the claimed intellectual
review, full-draft identity or semantic confirmation of every factual claim. Those
remain the manager and reviewer's responsibility. Live model compliance and installed
desktop behavior require separate validation. Free-model, permission and provider
guards are unchanged. Runtime availability remains as listed above.

# Home team inbox

`HomeTeamInbox.tsx` is the Team inbox view in the existing personal Home task
widget. It reuses Home card styling and shared controls. The section has its own
bounded scroll area, so long run history does not enlarge Home indefinitely.

Project selection is explicit and initially empty. Only the selected project's
assignment titles, failures, routines and history render. This is not a Chief
conversation or a cross-project model summary. The current runtime inbox payload
still contains full latest runs across projects; a status-only server projection
for sensitive projects remains a release integration concern.

## Client and bridge

`lib/personal-home.ts` parses every result before the UI uses it. The release
coordinator must register these `desktop_personal_home` actions against the real
TeamRuntime, with the same arguments as its methods:

| Action | Runtime method | Arguments |
| --- | --- | --- |
| `team-inbox` | `inbox` | none |
| `team-details` | `details` | `projectId`, `teammateId` |
| `team-send` | `send` | `projectId`, `title`, `text`, `requestId` |
| `team-ack` | `ack` | `projectId`, `teammateId`, numeric `revision` |
| `team-propose-routine` | `proposeRoutine` | `projectId`, `title`, `text`, `schedule`, `allowedActions`, `limits` |
| `team-confirm-routine` | `confirmRoutine` | `projectId`, `routineId`, string `revision` |
| `team-pause-routine` | `pauseRoutine` | `projectId`, `routineId`, string `revision` |
| `team-pause-continuation` | `pauseContinuation` | `projectId`, `runId` |

The unavailable result is `{ code: 'team_runtime_unavailable', message, at }`.
It throws `TeamRuntimeUnavailableError` in the client. Missing, malformed and
failed reads are not successful empty responses. An inbox read must succeed
before mutation controls become available. There are no automatic write retries.
Native host operations use `desktop_ai_host_status` with no arguments and
`desktop_ai_host_configure` with `wakeProtectionEnabled`. These are separate
commands, not personal-home actions.

The renderer's availability checks are not authorization. Native registration
must enforce trusted local main-frame and local-runtime ownership. Web, remote
desktop, VS Code, hosted mobile and Capacitor do not get local credentials or
host controls. Enterprise and network restrictions hide these controls; their
owning runtime must independently enforce its policy.

## Identity and navigation

Rows use the runtime's persistent teammate ID. Messages have separate durable
task and run IDs, not an accumulating transcript. A row with a saved manager
chat opens that ordinary chat in its recorded directory. A row without a chat
reveals its durable run details. Historical failures are retained in the
existing AI Tasks view as well.

Manager, child and revision links reuse ordinary session navigation. Artifact
buttons open the recorded source message in the recorded parent or child chat;
an artifact with no recorded owning directory cannot open. No filesystem path
or child identity is inferred from prose. A current inspect failure is shown
from the structured failure stage, not from an accumulated historical counter.

## Drafts, reads and routines

Message drafts and their request IDs are scoped by runtime and project. Changing
the text changes the idempotency key. A failed response retains the draft; a
successful saved run without a failure clears only the submitted draft. Hidden
task views stay mounted to retain drafts but perform no ongoing reads. Drafts
are in memory for the Home mount, not durable across reload or app restart.

Reads reject superseded runtime, scope and mutation generations. A failed
refresh retains previously loaded same-project results. Team refresh is manual
or on view activation, not a live subscription. A 15-second notice explains a
slow read without dropping input. The legacy AI Tasks view still polls only
while active.

Routine proposals are explicit and inert. A message mentioning recurrence does
not create a routine. Review shows the saved objective, project, schedule,
timezone, read-project action, occurrence limit, observed-token guardrail,
proposal revision and policy revision. Confirmation and pause use that saved
revision. Only a returned `nextRunAt` is shown; the current proposal contract
may omit it until confirmation. Allowed occurrence limits are 1–31 and token
guardrails 1–10,000,000, matching the runtime schema.

Usage is displayed only when the runtime says it is available. Missing usage is
not displayed as zero. Provider-reported cost and observed tokens are explicitly
not hard dollar caps. Project/account guardrail values are not exposed by the
current UI response contract. Host pickup configuration is labeled enabled or
paused, never inferred to mean that an agent is actively working.

## Validation

`HomeTeamInbox.test.tsx` exercises the real parsed desktop client and rendered
controls with a synthetic bridge. It covers project isolation, identity across
runs, no-chat failure, saved results after child/evidence failure, recorded chat
and artifact links, unread acknowledgement, explicit routine proposal,
revision-conflict handling, confirm/pause, idempotent retry and draft retention,
loading/read errors and unsupported native operations. `HomeAiTasks.test.tsx`
also keeps historical pre-chat and child-read failures inspectable.

These fixtures are not evidence of live native IPC registration, production
dispatch, scheduling, provider policy enforcement or wake protection. Those
remain integration and release checks owned by the runtime/native workers and
release coordinator.

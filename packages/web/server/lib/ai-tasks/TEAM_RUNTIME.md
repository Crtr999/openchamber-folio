# Local team runtime

`team-runtime.js` owns durable team dispatch. `team-state.js` validates version-1
tracking and keeps the single-dispatcher lock. History and lifetime token totals
are retained. Per-run observed tokens and cost never decrease on a later inspection.
No allocation reset, automatic paid fallback, or project configuration
mutation is implemented here.

## Dispatch and recovery

One run may execute at a time across all projects. A saved `pausePending` flag or
legacy pause failure blocks every new send, revision, and routine occurrence.
The flag is saved before interruption. Successful executor interruption clears it;
failed interruption stays visible and the host keeps polling. Restart does not
clear the barrier. The executor owns verification of parent and child interruption.

Three consecutive inspection failures stop authorization and attempt interruption.
Safe inspect codes identify the failed accounting, children, evidence or result
step and distinguish invalid response, SDK HTTP status and unavailable transport.
Raw error messages and task content are never part of those diagnostics.
A complete successful inspection resets the counter. A task still pending or
running one hour after its durable claim goes to Needs you and attempts interruption.
This is an observation deadline, not proof of inactivity or of model cancellation.
Permission waits are not accepted automatically. An affected routine is paused and
keeps its failure reason. Routines remain finite, with at most 31 reviewed occurrences.
Confirmation still requires the exact proposal revision and unchanged policy.

`recover({ projectId, runId })` retries unresolved interruption, then inspects the
saved session and evidence when host policy permits. It never creates a session,
sends a prompt, resets budgets, or confirms a paused routine. Pending evidence does
not turn a terminal run back into authorized running work. A verified terminal
answer can replace the saved blocked result. Failed reads are not empty success.

`revise({ projectId, runId, revision, text, requestId })` requires the exact numeric
run revision from details and a terminal source run. It creates a separate run with
`revisionOf`, `sourceRevision`, and bounded `savedContext` from that source. Source
assignment and result are data, not new approval. Project and directory must match.
The caller's request ID is project-scoped and shared with ordinary send IDs. Repeating
the same request returns the original revision run, even after an ambiguous send;
changed source, source revision, or text is rejected. There is no blind resend.

Ordinary sends also freeze their bounded project-only saved context before dispatch.
New sends freeze the v2 independent adversarial completion contract documented in
`DOCUMENTATION.md`. Recovery retains the saved v1, v2 or historical contract.
An ambiguous routine dispatch pauses further occurrences and retains its reason.
Polling changes unread only for semantic run changes. Inspection counters and repeated
diagnostic timestamps alone do not mark a teammate unread.

## Public contract handoff

The owning declarations are `team-runtime.d.ts` and `team-state.d.ts`.

- New methods: `revise` and `recover`, both returning `TeamRun`.
- Read-only `getRun({ projectId, requestId }): Promise<TeamRun | null>` uses the
  identical project-scoped stable ID as send. Notion interruption recovery must
  look up `notion:<notionRun.id>` only, never call send. Missing returns null;
  unavailable tracking throws. It makes no model calls and does not change unread.
  `details({ projectId, teammateId })` retains its existing scope and labels.
- Optional `TeamRun` fields: `pausePending: boolean`, `revisionOf: string`,
  `sourceRevision: number`, `savedContext: string`.
- Optional `TeamRoutine.failure: TeamFailure`.
- `TeamFailure.stage` additionally accepts `stall`; deadline failures use code
  `deadline`, observed limit failures use `token-guardrail`.
- No state version change. Existing version-1 files load without the new fields.
- `onWorkState` keeps reporting `required` while interruption is unresolved.

The supervisor must update the older team declarations in `runtime.d.ts` and bridge
allowlists if consumers still use them. Those files are outside this worker's ownership.
The UI should obtain the source revision from details, never infer it from an inbox
acknowledgement. Recovery is not a Resume or Retry send action.

Electron local desktop uses the coordinator. Web, VS Code, hosted mobile and Capacitor
gain no new setup, controls or routes from this module change. Remote desktop pages
remain excluded from local coordinator IPC.

## Queued user assignments

`enqueue` shares send's project-scoped request keys, dispatch lock, manager,
reviewed specialist profiles, model gates and lifetime usage limits. Identical
request retries return the original run; changed input is refused. It resolves
and saves the folder, concrete model, policy revision and instruction revision
before returning, without creating a session. At most eight assignments may wait
per project and 32 across this host. Paused waiting work counts toward capacity.

`pendingDispatch: true` identifies known-undispatched work. Check skips it during
interruption recovery, then starts the first queued run only after all existing
execution and interruption checks settle. The current folder, model, policies and
agent instructions must still match the frozen snapshot. Changed or unavailable
policy produces Needs you. The existing creating write clears pendingDispatch
before session creation, so an ambiguous create or send cannot return to the queue.
An executor instruction hash is separate from historical policy hashes to retain
compatibility with existing running and scheduled work.

Pause preserves undispatched intent across restart. `resumeQueued` requires an
explicit user action and an unchanged snapshot. `cancelQueued` removes execution
intent while retaining history. Neither resumes a dispatched session. Queueing
never enables a routine, resets budgets, approves tools or registers new agents.

The Friends work view uses this same coordinator as AI Tasks. Local Electron
exposes the strict team actions through its trusted main-frame bridge. Remote
Electron, web, VS Code, hosted mobile and Capacitor gain no queue entry points.

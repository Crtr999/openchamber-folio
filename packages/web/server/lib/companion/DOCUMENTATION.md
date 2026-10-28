# Companion follow-ups

Opt-in responsibilities and project activity follow-ups shared by desktop and mobile. They are ordinary project scheduled tasks with `companion:` IDs, not another conversation store, scheduler or background model connection.

## Routes and authority

Registered through feature routes behind the existing API authentication boundary:

- `GET /api/projects/:projectId/companion` lists only companion-owned schedule rows.
- `PUT` on the same route validates a strict name/prompt/time/timezone/model payload and delegates to `scheduledTaskService.upsert`. The stable client-generated ID makes an explicit retry after an uncertain response update the same row.
- `PATCH /api/projects/:projectId/companion/:taskId` pauses/resumes a matching row without removing its last state or execution.

Project resolution, persistence locks, duplicate-occurrence claiming and run status remain owned by the scheduled task service. The same records can be inspected in desktop Scheduled Tasks. Results are regular root conversations and use the existing notifications and artifact paths. An unavailable list remains an error, not a successful empty list. UI responses are schema-parsed, refresh failures preserve existing rows and runtime changes close the panel.

Companion routes first resolve the project from the settings index and apply the permanent folder guard. Named ZDR folders, ZDR-bound folders, descendants of configured ZDR roots and unreadable bindings return `403 private_folder` before schedule synchronization or companion state reads/writes. PIN verification never relaxes this exclusion. The coordinator applies the same guard before activity tracking, timer reads, context collection and notification indexing. Delivery refuses private run preparation and checks project eligibility before reading an enrolled result. Existing private inbox records are left on disk but are not returned or delivered.

Every newly saved companion row requests goal mode with a 10,000-token budget and never opts into permission auto-accept. This uses the existing goal accounting and settings; it is not an independent provider billing cap or a guarantee that a single model turn cannot exceed a threshold. Project provider restrictions and ordinary tool authorization still apply in OpenCode. The prompt reminds the agent to use scoped memory, verify current facts and avoid unsupported or repeated suggestions. That prompt is guidance, not an authorization boundary.

## Runtime behavior

Web, hosted mobile, Electron and native mobile use the same server API where connected. The same management UI opens from the desktop Home dashboard and mobile companion button. Desktop Scheduled Tasks can also inspect the underlying schedules. VS Code has no companion management UI or added route bridge. No listener, external endpoint or provider fallback is added by this module. Cloud hosting changes data location only through separately authorized deployment/migration.

## Limitations

Daily schedules, activity wakeups, previous-result context, a persistent inbox, exact-result deduplication, quiet hours and daily alert caps are implemented. Automatic enrollment, vendor-specific webhooks and semantic opportunity ranking are not implemented. The user's specified project responsibility and source permissions determine what can be checked. A cloud instance cannot read Mac-only files or conversations while the Mac is offline. The cloud virtual desktop and secure mobile Computer transport are separate work.

## Validation

HTTP tests cover authentication gating, strict input validation, schedule/model mapping, non-auto-accept execution, filtering and pause preservation. Existing scheduler tests cover persistence/claiming. UI tests cover the same root result link, pause/refresh, failure preservation and stable retry identity. Real-device delivery and a real cloud deployment are release gates, not proven by these tests.

## Previous results and quiet delivery

`delivery.js` enrolls each new companion run in session metadata before goal setup or prompt dispatch. The enrollment records the task ID and previous result session ID. An enrollment write failure stops dispatch. The previous assistant reply is supplied as bounded, untrusted evidence through a non-resuming synthetic message. Normal project knowledge, permissions and model selection remain with their existing owners.

A successful unchanged check can return exactly `[CARTER_NO_UPDATE]`. The server suppresses completion delivery only for an enrolled session with that exact reply, or an identical complete previous reply. Empty, unreadable and truncated results do not count as unchanged. Ordinary chats cannot opt into silence merely by returning that text. Goal failures, budget stops, errors, questions and permission requests keep normal delivery. Results remain regular conversations even when no alert is sent.

The goal completion callback checks the same policy before native desktop, live UI and push fanout. The per-turn completion path checks it when goal mode is disabled. The policy does not suppress semantically equivalent rewordings unless the agent marks them unchanged. This is noise reduction, not a guarantee that a model always identifies useful changes correctly. No client timer, extra model audit, new provider or second result database was added.

## Persisted inbox and activity coordinator

`state.js` validates the versioned `companion` field in the existing project document. `project-config.js` updates it under the same atomic-write and cross-process lock as scheduled tasks, preserving unknown fields and rejecting malformed state. No second conversation store is introduced: inbox entries point at ordinary result sessions.

`coordinator.js` observes root-session idle events only for opted-in projects. It coalesces activity for two minutes, limits activity checks to three daily and one per two hours, ignores its own sessions, and uses the existing scheduled task runner. The daily 09:00 monitor is a separate backstop. Context includes bounded prior inbox results as untrusted evidence. Model guidance can reduce reworded repeats, but server deduplication compares complete exact results, not meaning.

Results persist before delivery is attempted. Delivery claims expire after two minutes; failures retry after five minutes. Quiet hours and per-project daily caps defer completion alerts without dropping results. A successful fanout marks an attempt, not proof that a device received it. Questions, failures and permission requests retain the ordinary notification path. Seen/dismissed records persist and are supplied to later checks.

Additional authenticated routes:
- `GET /companion/inbox` returns settings and nondismissed results.
- `PATCH /companion/inbox/:entryId` marks seen/dismissed.
- `PUT /companion/settings` updates activity opt-in, selected model, timezone, quiet hours and alert cap; schedule changes roll back when state persistence fails.
- `POST /companion/wake` accepts an empty object to request a bounded activity check from an existing authenticated integration. It accepts no prompt or credential.

Changes travel over the existing authenticated control event stream (`openchamber:companion-changed`). UI reads are generation-guarded across project/runtime switches and preserve dirty settings. The server owns one unref timer, stopped during graceful shutdown. No new network listener or client polling loop is added.

A server must remain online to run checks. Free Apple Personal Team builds cannot receive APNs remote push; results remain in the shared inbox and conversations. A full push-capable build still requires supported provisioning and delivery configuration. These constraints are separate from server scheduling.

Saving monitoring preferences preserves an existing monitor responsibility and its source restrictions; the selected model and quiet hours are updated without replacing the responsibility with the default prompt.


## Approved personal awareness review

Settings > Connections > Personal suggestions is the explicit enrollment path.
`awareness-enrollment.js` owns authenticated `GET`, `PUT` and `DELETE` at
`/api/companion/personal-awareness`. GET lists permitted indexed folders and
their currently configured, enabled OpenAI models. The private native status
callback reports saved connections and calendar authorization without reading
source bodies or requesting OS access. Opening settings never opts in.

PUT requires `approved: true`, the exact folder/model, a nonempty `sources`
allowlist and verified connected mailbox addresses. It first disables old
consent, creates the ordinary `companion:personal-awareness` daily 09:00
schedule, then saves new consent. Failed schedule or consent persistence leaves
consent disabled and attempts schedule cleanup, preserving any prior schedule
and its history in the paused state. DELETE disables consent before
pausing the schedule and stays available under enterprise policy. Revocation
stops future preparation, not a model request already sent. Old approvals
without an explicit source allowlist fail closed and require approval again.

Native collection and engine evidence both honor the source allowlist.
Unselected chat, follow-up, Notion, calendar and Outlook sources are not read.
Calendar output exceeding the 50-event review cap is partial, never ready.
No consent, credentials or schedules are created by installing the feature.

| Runtime | Enrollment and sources |
| --- | --- |
| Web | Existing Connections page and authenticated server routes; native sources only when supplied by its host. |
| Electron | Same routes/page; local native connections remain separately approved. |
| Hosted mobile | Same server approval and results, no phone-native source connection. |
| Capacitor | Same connected-server approval and results, no phone-native source connection. |
| VS Code | No enrollment UI or native reader; no companion route bridge. |

`personal-awareness.js` prepares only `companion:personal-awareness`, after checking a persisted `commitments.json.awareness` approval, exact project and OpenAI model, current enterprise policy and folder exclusions. It uses the existing scheduled-task runner, result sessions, companion inbox, quiet hours and notification attempts. It adds no listener or polling timer. Session permissions deny every tool except the managed OpenChamber tool; control then limits that enrolled conversation to commitment actions.

The optional Electron in-process reader retains ownership of its encrypted Notion connection. It returns at most four page excerpts per run, a bounded configured task-board snapshot and the native calendar reader's next seven days. The server requests one 100-session page, reads at most four eligible root conversations, excludes live/archived/companion/ZDR/provider-bound conversations, and includes bounded existing commitments and follow-up inbox entries. This is partial, rotating coverage, not a claim that every historical message or every Notion page was reviewed. Notion search starts with recently opened pages and deadline/assignment searches. Outlook remains `needs-connection` for each selected address until supported provider connections are implemented and authenticated. Live testing found that Outlook’s local scripting API did not expose the selected accounts even while its CBC calendar window was connected. That experimental reader is retained outside the release, not shipped. A signed-in Outlook window is insufficient.

Review receipts, source health, a Notion offset and a chat cursor are stored in the existing commitments file. Source bodies are not duplicated there. Receipts advance only after a nonempty completed review reaches the companion delivery inspector. A failed dispatch keeps sources eligible. Changed excerpts are supplied again; unchanged calendar events remain visible as time passes. Missing source reads remain errors or partial coverage. The prompt distinguishes newly changed connection failures from previously reported ones. Exact result deduplication remains server-owned; semantic significance and suppression of reworded suggestions still depend on the model.

External source records mentioning ZDR or a denied configured folder's path/name are removed before evidence and review fingerprints are collected. This is reference filtering, not a claim that an unlabelled calendar event can be classified as confidential. Native IPC readers remain responsible for their own collection and display boundary.

New obligations added by this review are pinned to its approved OpenAI model and cannot use web research. Exact active-title duplicates update their date rather than create a second obligation. Follow-up checks recheck the folder's provider policy. Normal user-created commitments keep their existing model behavior.

Electron supplies native sources. Web and hosted/mobile clients consume the server's results, with explicit source errors if no native reader exists. VS Code gains no native connection or companion route. The Mac must remain awake and the app running for local scheduled checks. Native iPhone remote push remains unavailable on free weekly signing.

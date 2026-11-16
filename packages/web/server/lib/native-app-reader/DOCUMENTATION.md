# Background native app reads

This module authorizes explicit agent reads of Calendar events and incomplete
due Reminders. Electron supplies a separate EventKit executable through
`startWebUiServer({ nativeAppReader })`. It runs without app activation. There
is no shell, AppleScript, UI automation, database access or write operation in
this adapter. The existing Home helper still owns its separate write workflow.

## Agent contract

The managed `openchamber` tool has four actions:

- `native.status` checks connector installation and runtime support. It reads
  no app content, does not check or request OS access, and returns
  `permissions: 'not-checked'`. Available means the helper is installed, not
  that content access has been granted.
- `native.containers` accepts `app: 'calendar' | 'reminders'` and
  `requestedByUser: true`. A local Cancel / Show container names dialog asks
  the user before listing names and identifiers. It reads no event or reminder
  content and creates no ongoing grant. The user then chooses an exact ID.
- `native.requestApproval` accepts that app, exact user-selected `containerId`
  and `requestedByUser: true`. The native Cancel / Allow read-only access /
  Revoke access dialog shows the canonical folder, provider, provider
  configuration fingerprint and exact container. Only the user's click changes
  grants. The default and Escape choice are Cancel. An existing Calendar or
  Reminders selection supplied by the user may skip metadata discovery.
- `native.read` accepts `app`, `containerId`, `start`, `end`, optional `limit`
  and `requestedByUser: true`. Use it only for an explicit user request, never
  as background awareness or automatic enrichment. Dates must include a timezone,
  span at most 31 days, and increase. Limit defaults to 50 and cannot exceed 100.

Authorization reads the calling session from OpenCode, canonicalizes both its
directory and the callback's authoritative directory, and requires equality.
Caller parameters cannot override that scope. Legal/ZDR directory components and
ZDR provider/agent selections are refused even if a grant exists. This adapter
imports no records, rules or memory from those folders.

The local user must approve an exact directory, provider configuration, running
desktop host and app container. Approved scopes are saved atomically in
`<openchamber-data-dir>/native-app-read-grants.json`. No grant is created
automatically. A missing, malformed or unmatched grant fails closed with 403.
A malformed file is never silently replaced by the approval action. The server
rechecks the session, provider configuration and host after each native dialog
and before returning native results. Cancellation, a changed owner or a changed
scope cannot persist an approval or release fetched content.

The persisted shape uses synthetic identifiers below. Agents must use the
native confirmation flow, not manufacture this file:

```json
{
  "version": 1,
  "grants": [{
    "directory": "/approved/conversation",
    "providerID": "approved-provider",
    "providerBinding": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "runtimeId": "current-desktop-host-uuid",
    "runtimeEndpoint": "http://127.0.0.1:4096",
    "app": "calendar",
    "containerIds": ["exact-user-chosen-calendar-identifier"]
  }]
}
```

There are no wildcard grants or automatic container discovery. Metadata discovery
requires a separate native user confirmation every time. It returns at most 100
container IDs and bounded names, with an explicit truncated flag. A read grant
binds a SHA-256 fingerprint of the running directory-scoped OpenCode provider and
model records, including endpoint settings and model overrides. The runtime ID
is unique to this desktop-host lifetime, so restarting the host expires grants.
The running OpenCode API origin is bound separately as `runtimeEndpoint` and
shown in the native confirmation. Changed runtime origins, provider endpoints,
provider settings or model configuration require new approval.
Directory policy bound to a ZDR provider is refused before provider queries,
metadata discovery, native confirmation or content reads.

Existing OS full-read access is also required; background reads and metadata
discovery never ask for it. The read-only executable is compiled into
the existing CalendarBridge app bundle and uses its permission identity. Live
permission identity and signed packaging still need authorized native QA.

## Results and limits

Content success is `{ status: 'ok', items, truncated }`. Metadata success is
`{ status: 'containers', containers: [{ id, title }], truncated }`.
Approval results use `status: 'approved' | 'revoked' | 'cancelled' | 'busy' |
'unavailable'`; approval and revocation also return the exact scope. Items contain only ID, bounded
title, start/end and all-day state. Reminders use their due date as start and
have null end. Completed reminders and reminders without a due date are excluded.
Calendar includes events overlapping the requested half-open interval. Reminders
include due dates in that interval. Only the exact requested container is queried,
then membership and time bounds are checked again in native code.

Failures are distinct from empty success: `permission-required`,
`permission-denied`, `container-unavailable`, `unsupported`, or `error`, with a
safe reason. Invalid agent inputs return 400 and authorization refusals return
403 through the existing versioned tool envelope. A permission failure is an
operational result, not an empty item list. No content is logged, stored or
automatically sent to another provider. Tool results reach the requesting
session's explicitly granted provider through OpenCode. This local path adds
no external egress or listener and remains available in enterprise mode.

Native reads have a 20-second deadline, cancellation, a 512 KiB output ceiling
and validated result shapes. Reminder fetch failure and timeout are errors,
never empty success. Request or process failure does not change existing data.

## Support

| App | Support |
| --- | --- |
| Calendar | EventKit, one exact calendar and bounded date range |
| Reminders | EventKit, one exact list and bounded incomplete due-date range |
| Notes | Explicit unsupported result, no content access |
| Mail | Explicit unsupported result, no content access |

| Runtime | Behavior |
| --- | --- |
| Local Electron on macOS | Bundled helper, session grant and existing OS access required |
| Electron on Windows/Linux | Unsupported, no process launch |
| Web server without injected host adapter | Unsupported, no native access |
| Remote desktop | No local IPC or native privilege transfer; remote server remains unsupported without its own adapter |
| VS Code | Managed tool not injected, no native reader |
| Hosted mobile / Capacitor | No client-native access; connected managed-server tools follow that server's authorization |

Tests use synthetic sessions, grants, process streams and results. Swift
compilation and these tests do not prove live content reads, permission
prompts, focus preservation in a running signed build, or HMR/bundled startup.

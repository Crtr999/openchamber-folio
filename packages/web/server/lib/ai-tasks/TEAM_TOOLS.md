# Bounded team tools

The host adapter and dispatch attestation are implemented. Activation remains
project-local and requires a host registry plus an active reviewed plugin.
Business Launch setup tests use separate verification state, not production
inbox history. Production activation and installed-UI proof remain pending.
Only the approved Business Launch project should receive these tools. Legal,
ZDR, ChatGPT and every other project remain unchanged.

## Host integration

1. Use the pinned v2 plugin contract. As documented in
   `../opencode/DOCUMENTATION.md`, a plain `{ id, setup }` definition is supported.
   A configured plugin must be a directory with a package entrypoint. Bundle its
   existing dependencies into that entrypoint. Do not download dependencies or
   change global defaults.
2. Provision a dedicated, real `team-output` directory directly inside the
   canonical approved project. The writer does not create directories. Keep the
   project root, its ancestors, and this output directory host-owned for the run.
   Exclude this directory and its ancestors from agent rename, replacement,
   deletion, hardlink and symlink operations. Other file tools must not write here.
3. In a trusted plugin entrypoint, import `Plugin` from that existing package and
   `createTeamToolsPlugin` from this module. Default-export its result:

   ```js
   export default createTeamToolsPlugin(Plugin, {
     directory: approvedCanonicalDirectory,
     projectId: approvedOpenCodeProjectId,
     exclusiveOutputOwnership: true,
     authorize: authorizeCurrentTeamCapability,
   });
   ```

   `projectId` is the OpenCode location project's ID, not an assumed app project
   ID. The host must resolve that mapping. The arguments are trusted host values,
   never model arguments or mutable project plugin options.
4. Implement `authorize` as a host-authoritative, cancellable check. It receives
   `{ sessionID, directory, projectId, action, signal }`. Return literal `true`
   only for an active approved team run and its explicitly admitted descendants,
   the exact approved canonical project, and a current grant for `team_compute`
   or `team_output`. Revoked grants, paused runs, unknown sessions, unrelated
   sessions and failure must refuse. The plugin fetches and validates the current
   session location both before and after this check. It never replies to pending
   permissions or rewrites session rules. The host check must honor its 5-second
   signal. The plugin races each lookup and authorization check against that
   deadline and cancellation, so a late answer cannot trigger output. This bounds
   waiting, not the lifetime of an uncooperative injected request. If a process
   bridge is needed, its authentication and run lookup belong
   to the supervisor, not these numeric modules.
5. Add the two exact tool actions to that team's session policy only. Keep shell,
   interpreters, code execution, plugin/config edits and tool-registration changes
   denied. Keep unrelated external actions denied or explicitly approval-gated.
   Existing safe project reads can remain available. A project-read tool is not
   added here. These tools do not implement external actions or publishing.

Registration uses `Plugin.define` and `ctx.tool.transform`, with direct tools
named `team_compute` and `team_output`. Cleanup disposes the registration. It
does not touch agents, models, providers or global settings. There is no default
export in the helper itself because host authorization must be supplied.

`team-tools-host.js` registers forwarding tools only. It uses the existing
managed-child callback URL and in-memory bearer credential, restricted to
loopback. It never reads a tracking file to grant permission or writes outputs
in the OpenCode process. The existing host listener serves the fixed
`/api/openchamber/team-tool` route with the same managed-child authentication.
No new network listener or persisted credential is added.

The production dispatcher serializes tool execution with run transitions.
`team-executor.authorizeTool` checks the frozen policy revision, actual direct
parent and child session records, project directory, exact free model, zero
reported cost and admitted tool permission. Pause requests and shutdown
invalidate an operation epoch before queueing. After all asynchronous checks,
the host verifies its dispatcher nonce and cancellation, then performs fixed
arithmetic or create-only output synchronously, with no intervening await.
Missing state, absent ownership, changed policy and revoked grants refuse.
`verifyTeamToolsInstallation` checks the project-local entrypoint against the
host registry digest. The executor additionally requires active plugin status.
Output receipts are checked against actual file bytes before becoming artifacts.
Delegation and bounded tool rules retain `ask` unless the corresponding
project-local agent definition explicitly grants `allow`. The Business approval
does not turn on automatic permission grants for another version 2 team.
Routine proposals list all reviewed capabilities. The runtime refuses a
proposal, confirmation or occurrence if any admitted specialist capability is
outside that action list. Routine output and computation also require the
matching approved action at operation time. Paused routines revoke pending
operation epochs. Historical read-only proposals retain their original shape.

Runtime availability remains explicit: Electron local uses its native team
dispatcher; web returns unavailable without an explicitly injected team host;
VS Code, hosted mobile, Capacitor mobile and remote desktop receive no native
team tools or local grants from this integration.

Electron local is the intended consumer. Web, VS Code, hosted mobile, Capacitor
mobile and remote desktop do not gain privileges merely by importing this module.
Their host must explicitly provide the same authorization and filesystem contract
before registering it. No new renderer or server route is shipped.

## Computation contract

The runtime revalidates strict schemas even if an SDK skips schema validation.
Extra fields, source code, filesystem paths, URL inputs and operation names
outside the fixed list are rejected.

The native `team_compute` tool accepts `{ request: string }`. The string contains
one JSON object from the operation schemas below, capped at 131072 characters.
The exact free model emitted strings for array and number fields during a live
test, so the plugin now parses an explicit JSON string before strict arithmetic
validation. It does not coerce numbers, evaluate expressions or accept code.
For example, call it with
`{"request":"{\"operation\":\"stats\",\"values\":[1,2,3,4]}"}`.
Direct `teamCompute` callers still pass the typed object.

- `stats`: 1 to 4096 finite numbers, each between -1e12 and 1e12. Returns count,
  sum, mean, min, max, median and population variance using Welford accumulation.
- `compound_growth`: nonnegative principal/contribution up to 1e12, rate between
  -1 and 1, and 0 to 4096 periods. Interest precedes each contribution. Returns a
  row per period and final balance. Results above 1e15 or nonfinite values refuse.
- `weekly_below_average`: caller-supplied synthetic weekly prices, 1 to 4096
  positive values up to 1e12, weekly budget up to 1e12, lookback 1 to 520.
  Deposit the weekly budget first. Warm-up retains cash. Each later week's
  decision compares its price strictly below the preceding lookback average,
  excluding the current price. A buy spends all available cash. The benchmark
  buys every week. Both value at the final supplied price. No sales, fees,
  slippage, taxes, dividends, market downloads or investment execution.
  `syntheticOnly` labels the simulation contract. Numeric inputs alone cannot
  establish their provenance; it is not verification that prices were generated.

All loops are bounded and check cancellation and a 100 ms monotonic computation
budget. Input arrays are length-checked before member parsing. Result JSON is
capped at 1 MiB. Arithmetic is ordinary floating point, not decimal accounting.
The elapsed budget is cooperative, not an OS preemptive CPU limit. No general
interpreter, worker code, shell, dynamic import, environment reader or network
client is exposed. Permission scoping is not claimed to make arbitrary code safe.

Examples:

```json
{"operation":"stats","values":[1,2,3,4]}
{"operation":"compound_growth","principal":100,"rate":0.1,"periods":2,"contribution":10}
{"operation":"weekly_below_average","prices":[10,12,8,16],"weeklyBudget":10,"lookback":2}
```

## Output contract and limits

`team_output` accepts only `{ filename, content }`. The filename is a flat ASCII
basename, maximum 96 characters, starting with an alphanumeric character and
ending in `.txt`, `.md`, `.csv` or `.json`. It never reads source files or accepts
an output directory from the caller. UTF-8 content is capped at 256 KiB. The
dedicated directory is capped at 128 entries and 8 MiB total. Existing symlinks,
directories and multiply-linked files in it block writing.

Canonical realpath containment and pinned device/inode checks reject symlinked
or replaced roots and output directories. File creation uses `O_EXCL` and
`O_NOFOLLOW`, mode 0600, then validates the opened regular file and flushes it.
An existing filename always refuses, even with identical content. A success
receipt contains version, absolute path, project-relative path, byte length and
SHA-256 of the exact bytes written. A receipt is file provenance, not verification
of the claims in the document. Markdown and CSV remain untrusted data, not HTML
pages, executable instructions or safe spreadsheet formulas.

Failure may leave an empty or partial new file with no receipt. It is never
silently overwritten, retried or deleted. A user can inspect it and choose a new
filename. Disk I/O and a stalled filesystem are not bounded by the arithmetic
deadline. The quota is checked synchronously within one writer process; other
writers/processes must be excluded by the host ownership contract.

Important boundary: Node's portable filesystem API does not offer `openat`.
The tested Mac also rejects `/dev/fd/<directory-fd>/<filename>`. Realpath checks
alone cannot defeat a concurrent hostile host process swapping ancestors between
checks. `exclusiveOutputOwnership: true` is the host's required assertion that
this cannot happen under the admitted tool set, not a sandbox proof. Do not
enable output when the host cannot enforce that contract. No full host filesystem
or environment isolation is promised for the plugin process itself. The agent's
callable data interface exposes only fixed computation and this output writer.

## Current-task output reading

`team_read_output` accepts only `{ filename }` with the same flat filename rules
as the writer. A specialist needs the `read-output` capability and an attested
host tool installation. Its reviewed agent definition may preapprove this tool.
This does not approve generic file reads, directory scans or pending requests.

For every call, the executor scans completed output-tool receipts from the active
run and its observed children. Partial history, a different task's receipt,
changed bytes or a missing file refuses the read. The trusted reader argument is
`{ path, verified: true, sha256, sizeBytes }`, not the writer's receipt shape.
The reader uses `O_NOFOLLOW`, pinned directory identities, a singly linked regular
file, a 256 KiB limit and an exact byte-count/SHA-256 check before returning text.
The same exclusive host ownership requirement applies to reading and writing.

Changing a live team requires a coordinated deployment. Back up its policy,
agent definitions, generated guard, tool plugin and host installation registry.
Stage the new reader capability and tool permission with the matching generated
profiles, then regenerate the tool plugin and registry hash. Apply them only with
the compatible application stopped. Do not send old interrupted tasks again or
approve their pending permission requests as part of migration. On failure,
restore the complete backed-up set before restarting the previous application.

## Evidence

Focused Vitest files cover real arithmetic, byte/hash receipts, create-only
collisions, traversal, symlink roots and targets, hardlinks, directory replacement,
limits, cancellation, revoked grants, mismatched sessions and projects, and
external-action rejection. `team-tools-plugin.test.js` uses an identity
`Plugin.define` adapter and an in-process v2 context fixture, with real executors
and real output writes. It is not a real OpenCode plugin activation proof.
The supervisor must validate activation with the existing installed plugin
package and approved run identity before enabling the capability.

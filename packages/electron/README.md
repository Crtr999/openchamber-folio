# OpenChamber Desktop

Electron desktop runtime for OpenChamber on macOS, Windows, and Linux.

This package owns the native shell: windows, menus, deep links, native notifications, auto-updates, host switching, SSH connections, tunnel helpers, and packaged desktop builds. The web UI and OpenChamber server logic still live in `packages/web` and shared React UI lives in `packages/ui`.

## How It Runs

Desktop starts the OpenChamber web server in the same Electron main process. There is no separate sidecar subprocess for the OpenChamber server.

`main.mjs` imports `@openchamber/web/server/index.js` and calls `startWebUiServer()`. The Electron window then loads the UI from the local server in development, or from packaged `resources/web-dist` assets in packaged builds.

Electron loads `entry.mjs`, not `main.mjs`. Electron holds `ready` until the
entry module's import graph has evaluated, and importing the server module
graph blocks the main thread for a few hundred milliseconds, so the entry
stays small: the configuration that must precede `ready`, the single-instance
lock, and the first window. On `ready` it creates the main window on the HTML
splash through `early-startup.mjs`, waits (bounded) until the splash is on
screen, and only then imports `main.mjs`, which adopts that window through
`takeEarlyWindow()` and attaches its listeners. With packaged UI the splash is
served as `openchamber-ui://app/__splash` by the same scheme handler as the
application, so the navigation to the application stays on one origin and
Chromium keeps the splash frame until the application has painted; a splash on
a `data:` URL is another origin and the process swap shows an empty frame. Deep links and second launches
that arrive before `main.mjs` is loaded are buffered by the entry and replayed
once startup has resolved. The frame colour, window state, splash markup and
window options live in `early-startup.mjs` so the early window and any later
main window are built from one definition; both bundles import that module at
runtime rather than inlining it, or the handoff would see two copies.

The early splash and the shared HTML fallback use the same 64px mark and three
quiet loading dots. Their opacity animation stops in under five seconds and is
disabled under reduced motion. Both keep the saved theme colours; there is no
minimum splash duration and the visual treatment does not delay startup.

Login-shell environment discovery starts as soon as `main.mjs` runs and
proceeds asynchronously, so shell startup files run while the window comes up.
Startup callers share one probe and await its result before reading
shell-provided server flags or importing the backend. The probe tries
interactive login, then login-only on failure, with a five-second timeout per
attempt. Text that shell startup files print to stdout before the environment
is discarded, so a banner never fuses with the first variable. Failure
preserves the inherited process environment. Confirmed quit cancels an
in-flight probe and waits for its process to exit.

`bun run profile:startup` measures a packaged build's launch in an isolated
profile; see `scripts/perf/DOCUMENTATION.md`.

Quit, relaunch, and update installation await the in-process server's `stop()`
before exiting Electron. This lets the backend release its terminals, managed
OpenCode process, and guest services. `server-shutdown.mjs` bounds the server
wait to 35 seconds, allowing the terminal runtime's 20-second grace plus the
remaining backend cleanup. It uses the detached OpenCode killer only if normal
shutdown fails or times out. An external OpenCode server remains externally
owned. Closing to the tray does not stop the backend.

Update installation bounds the full background-service shutdown, including SSH,
to 40 seconds. This outer deadline leaves the backend's 35-second wait intact;
its timer is cleared when shutdown finishes.

See [process ownership and the #3589 investigation](./process-lifecycle.md)
for the launch paths, controlled reproductions, and Windows validation limits.

Same-origin session-chat iframes complete an authenticated parent-frame handshake before creating their SDK client. The parent supplies its active in-memory endpoint and credentials; when relay is active it also supplies the public relay descriptor without any pairing grant, because Electron preload and IPC are unavailable inside the iframe. The iframe establishes its own transport and rebinds its SDK before rendering. Additional windows retain their own per-window runtime bootstrap instead of being overwritten by the main window. Credentials are never placed in iframe URLs, and other child pages do not receive this runtime state.

The preload bridge exposes desktop-only APIs to the web UI through `window.__OPENCHAMBER_DESKTOP__`. Privileged commands are checked in `main.mjs`, not only in the UI.

The compatibility gate can reuse the embedded managed OpenCode CLI preflight
through `desktop_managed_opencode_compatible`. Main matches the requested
API origin to the local backend and reads the lifecycle-owned preflight promise.
A pending check is shared; successful checks allow UI initialization before
server health becomes ready. Restart invalidates the result. This avoids a second
CLI version process during startup.
External OpenCode, remote instances, HMR backends without an embedded handle,
and unavailable IPC retain the HTTP compatibility check. The renderer discards
IPC results if its endpoint changes while the read is pending.

## Main Files

| File | Purpose |
|------|---------|
| `entry.mjs` | What Electron loads: pre-`ready` configuration, single-instance lock, the first window, then a dynamic import of `main.mjs` |
| `early-startup.mjs` | Settings and window-state reading, splash markup, main-window options, the early window handoff and buffered app events; shared by both bundles |
| `main.mjs` | Electron main process, app lifecycle, windows, menus, deep links, native IPC handlers, updates, local server startup |
| `electron-host-probe.mjs` | Chromium direct-host probes, identity checks, attempt deadlines, and response cleanup |
| `host-probe-policy.mjs` | Selector fast attempt and unreachable-only retry policy |
| `startup-url-selection.mjs` | Pure bundled/HMR startup probe and loopback connection-limit policy |
| `shell-environment.mjs` | Asynchronous login-shell environment discovery and shared one-shot probe |
| `preload.mjs` | Safe bridge from the rendered UI to Electron IPC |
| `local-team-bridge.mjs` | Strict team-action input parsing and stable unavailable responses; callers must first pass the trusted local main-frame gate |
| `desktop_personal_teaching` / `desktop_teaching_skill` | Local-main-frame-only CarterBot recording, replay, model-selected skill drafting, reviewed installation and real test-chat dispatch. The web-owned broker reads global MCP connection settings; the `open-carter-teaching` guest gets only an ephemeral HttpOnly cookie and no native privileges. Drafts stay under userData/private-teaching. Capture cleanup and compiler cancellation run on close, runtime change and normal quit. See the personal-workspace documentation for approvals and failure behavior. |
| `ssh-manager.mjs` | SSH host import, connection lifecycle, tunnel/port forwarding helpers |
| `scripts/electron-dev.mjs` | Desktop dev launcher with Vite HMR support |
| `scripts/ensure-electron.mjs` | Verifies the installed Electron binary is complete and repairs it via the postinstall under Bun |
| `scripts/build-web-assets.mjs` | Builds `packages/web` and stages UI assets into `resources/web-dist` |
| `scripts/prepare-opencode-cli.mjs` | Downloads and stages the pinned OpenCode CLI into `resources/opencode-cli` |
| `scripts/opencode-cli-version.mjs` | Reads the pinned OpenCode CLI version and parses `opencode --version` output |
| `scripts/bundle-main.mjs` | Bundles Electron main code into `dist-bundle/{entry,main,early-startup}.mjs` for packaging |
| `scripts/rebuild-native.mjs` | Rebuilds native modules against the Electron runtime |
| `scripts/package.mjs` | Runs `electron-builder`, with unsigned Windows builds when signing env is missing |
| `resources/` | Packaged web assets, icons, and macOS entitlements |

## Development

### Direct-host probe invariants

After app readiness, direct-host probes use Chromium `net.fetch`, not Node fetch.
Each attempt shares one deadline across optional `/health` identity verification,
`/api/version`, and `/auth/session`, including JSON body reads. The fast attempt
has a 2-second budget. The selector retries once with a 10-second budget only
after Unreachable. Reported latency is the final attempt's application-probe
duration, excluding an earlier failed attempt. It is not raw network ping.

Probes never follow redirects. A redirected identity check returns Wrong Service
before any bearer-bearing request. An explicit server ID mismatch also stops the
probe. Electron 43 reports a manual redirect as a rejected fetch rather than a
3xx response; the identity gate handles both forms. Identity requests carry
neither the client token nor custom headers;
version and session requests use sanitized custom headers and the client bearer
token. Older servers without identity metadata remain supported. HTTP 401 and
403 mean authentication is required, not that the instance is offline.

Every exit aborts the attempt's requests and cancels unused response bodies before
clearing the deadline timer. This includes early HTTP classifications and a
successful session response whose body is not needed. TLS verification remains
enabled. These rules do not change relay probing or the preload/IPC contract.

From the repo root:

```bash
bun install
bun run electron:dev
```

`bun run electron:dev` starts the web dev server with HMR, then launches Electron against `packages/electron/entry.mjs`. On Windows, the HMR launcher resolves npm's `bun.cmd` shim to the underlying `bun.exe` before spawning Bun child processes.

The Electron workspace package trusts Electron's install script so `bun install` downloads the platform runtime in fresh checkouts and worktrees.

Electron's postinstall (`node install.js`) is run by `bun install` with the system Node. Older Electron releases bundled `extract-zip@2.0.1`, which under Node 24 silently unpacked only the first entry of the Electron zip, leaving `dist/` without the binary and `path.txt` missing. Electron 43+ ships its own fixed extractor (`@electron-internal/extract-zip`), but to keep interrupted or wrong-architecture installs from blocking desktop work:

- The root `postinstall` runs `ensure-electron.mjs --best-effort`, which detects an incomplete Electron install (missing binary, stale `dist/version`/`path.txt`, or a binary of the wrong architecture) and repairs it by re-running the postinstall under Bun (which extracts correctly), falling back to Node.
- `electron-dev.mjs` runs the same check (fail-fast, not best-effort) before launching, so `bun run electron:dev` self-heals even when an install was interrupted. On Windows, the repair resolves npm's `bun.cmd` shim to the underlying `bun.exe` before spawning it from Node.
- The check can be run on demand with `bun run --cwd packages/electron ensure:electron`; set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` to skip repair (e.g. CI without a network).
- Unit tests in `scripts/ensure-electron.test.mjs` (run via `bun run --cwd packages/electron test:architecture`) cover healthy/missing/stale installs, wrong-architecture binaries, repair fallback, and `--best-effort`.

Useful variants:

```bash
bun run electron:dev:bundled
bun run --cwd packages/electron ensure:electron
bun run type-check:electron
bun run lint:electron
```

`electron:dev:bundled` builds and uses packaged web assets instead of the HMR server. Use it when testing behavior closer to a packaged app.

Both dev variants run the staged OpenCode CLI from `resources/opencode-cli` (the one `prepare:opencode-cli` stages and packaged builds ship), not the `opencode` on PATH. `electron-dev.mjs` passes the directory to the backend as `OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR`; when the binary is missing it warns and falls back to PATH.

## Packaging

Built-in SDK extensions are built by the web build into `@openchamber/web/server/built-in-extensions`. Electron Builder unpacks that directory from ASAR, and `main.mjs` supplies its physical path to the backend. This keeps both iframe assets and future Node service entries usable. Sources and the registry live in `packages/extensions`; user data remains in the instance data directory.

From the repo root:

```bash
bun run electron:build
```

That runs, in order:

1. `build:web-assets` to build the web UI and copy it into `packages/electron/resources/web-dist`.
2. `prepare:opencode-cli` to download/cache the pinned OpenCode CLI and copy it into `packages/electron/resources/opencode-cli`.
3. `bundle:main` to create `packages/electron/dist-bundle/{entry,main,early-startup}.mjs`.
4. `rebuild:native` to rebuild native modules for Electron.
5. `package.mjs` to run `electron-builder`; its `afterPack` hook stages the compiled macOS icon asset catalog.

Build output goes to `packages/electron/dist`.

macOS builds produce `dmg` and `zip` artifacts. Windows builds produce an NSIS installer. Linux builds produce an AppImage for the native x64 or arm64 host.

## Platform Notes

macOS packaging needs Xcode/build tools for notarized builds and icon asset compilation.

Windows packaging needs NSIS support through `electron-builder`. If no Windows signing env is set, `package.mjs` disables code signing and builds an unsigned installer. Windows updates use `latest.yml` for x64 and the `latest-arm64.yml` channel for ARM64 so each installation resolves an architecture-matching installer.

Linux AppImages must be built natively. Set `OPENCHAMBER_TARGET_ARCH=x64` or `OPENCHAMBER_TARGET_ARCH=arm64` when packaging; the build rejects a target that does not match the Linux host. The same target selects the bundled OpenCode CLI, native Electron rebuild, and Electron Builder architecture. Linux identity is stable across architectures: executable `openchamber`, desktop file `openchamber.desktop`, icon `openchamber`, and `StartupWMClass=openchamber`.

After packaging, run `bun run --cwd packages/electron verify:linux-appimage`. The verifier extracts the final AppImage and checks its ELF architecture, desktop identity, Electron executable, pinned OpenCode CLI version and architecture, and all packaged native `.node` modules.

Running a packaged Linux AppImage requires FUSE (`libfuse.so.2`, typically `libfuse2` / `libfuse2t64` on Debian/Ubuntu). Without FUSE, start with `APPIMAGE_EXTRACT_AND_RUN=1`. Keep the AppImage on a writable path so in-app updates can replace it.

Desktop clears AppImage `ARGV0` from `process.env` before probing the login shell and starting the in-process server. Leaving it set makes zsh rewrite argv[0] for integrated-terminal and managed-OpenCode child commands to the AppImage path.

Linux updates are supported only when the packaged app is running from a writable AppImage. Update checks, downloads, and installation report an actionable error when `APPIMAGE` is missing, invalid, or read-only; a missing release feed (`latest-linux.yml` 404 before the first Linux publish) is treated as “no update available”. Authenticated Web clients connected to the embedded Desktop Host use this same `electron-updater` check, download, and restart flow rather than a package-manager command. macOS and Windows updater behavior is unchanged. Release builds keep `latest-linux.yml` (x64) and `latest-linux-arm64.yml` separate and validate each manifest against its AppImage before upload. Linux AppImages download full updates (no `.blockmap` differential channel yet).

`desktop_restart` does not answer the renderer before the install is decided. On the apply-update path it calls `quitAndInstall()` and keeps the IPC call open until the app quits or `autoUpdater` emits `error`, which the platform installers do asynchronously (a rejected code signature, or a Squirrel session disabled by an earlier failure). A failed install rejects the IPC call so the update dialog can show it, and the quit/install flags are rolled back because the app is staying up. A still-running app after the grace period resolves the call. The installer grace period starts after backend cleanup, so a slow terminal shutdown cannot remove the error listener before installation begins.

### Updater End-to-End Fixture

A loopback-only updater fixture is available for contributor QA of N-to-N+1 AppImage replacement and restart behavior. It is test infrastructure, not a user-configurable update source. See [`scripts/updater-e2e-fixture.md`](./scripts/updater-e2e-fixture.md) for the controlled test procedure. Unit tests cover feed selection, check failures, no-update results, and fixture generation; actual AppImage replacement and restart remains a manual native N-to-N+1 release boundary because it requires executing two packaged versions on each supported architecture.

The package supports macOS, Windows, and Linux desktop features. Linux AppImage builds include in-app window controls, auto-update, system tray (right-click Show / Hide / Close), and launch-at-login (XDG autostart). Opening files in installed apps, installed-app discovery, and FreeDesktop icon lookup (including the default file manager) work on macOS, Windows, and Linux.

On Windows and Linux, the General setting persisted as `desktopMinimizeToTrayEnabled` keeps the app running in the tray when the main window is **closed**. Minimize — the in-app control, the native title-bar button, and the taskbar — always performs a normal window minimize, so the taskbar entry stays available.

The macOS menu bar item is enabled by default and can be disabled in General settings. The setting applies after restart. While disabled, Desktop skips the native tray controller, tray-specific subscriptions, polling, and quota refresh. Dock badges remain independent: unread activity, session membership, and badge preferences still update the Dock through the shared IPC command. Turning off the Dock badge clears its count without enabling the menu bar item.

## Bundled OpenCode CLI

Packaged Desktop builds include the official OpenCode CLI release pinned by `opencodeCli.version` in `packages/electron/package.json` (OpenChamber requires OpenCode 2.x). OpenCode 2.x ships on npm rather than as GitHub release assets, so `prepare:opencode-cli` downloads the platform package tarball (`@opencode/cli-<os>-<arch>`, the same one OpenCode's own installer uses), caches it under `packages/electron/.cache/opencode-cli`, stages `opencode` or `opencode.exe` into `resources/opencode-cli`, and verifies `opencode --version` before packaging. Re-running the step is fast when the staged binary already matches the pinned version.

Managed local Desktop startup prefers OpenCode binaries in this order:

1. `settings.opencodeBinary`.
2. Environment overrides: `OPENCODE_BINARY`, `OPENCODE_PATH`, `OPENCHAMBER_OPENCODE_PATH`, or `OPENCHAMBER_OPENCODE_BIN`.
3. The bundled Desktop CLI in `process.resourcesPath/opencode-cli`.
4. System installs discovered from PATH.
5. Known npm/Bun/Homebrew/Scoop/Chocolatey and other standard install locations.
6. Platform discovery through `where opencode` on Windows or a login shell on macOS/Linux.

Use an explicit override when testing a different OpenCode CLI build or when a user needs to point Desktop at a custom binary. The configured path must point to the standalone CLI, not the OpenCode Desktop app executable.

## Common Env Vars

| Variable | Use |
|----------|-----|
| `OPENCHAMBER_ELECTRON_DEV=1` | Marks the runtime as desktop development mode |
| `OPENCHAMBER_ELECTRON_USE_BUNDLED_UI=1` | Uses staged web assets instead of the HMR dev server |
| `OPENCHAMBER_SKIP_LOCAL_SERVER=1` | Skips the in-process local OpenChamber server and uses the configured default remote instance; Desktop imports this from the user's login-shell environment, and packaged/bundled UI remains available for connection recovery |
| `OPENCHAMBER_HMR_UI_PORT` | Preferred Vite UI port for desktop dev, default `5173` |
| `OPENCHAMBER_HMR_API_PORT` | Preferred API port for desktop dev, default `3901` |
| `OPENCHAMBER_RUNTIME=desktop` | Set by Electron before starting the web server |
| `OPENCHAMBER_OPENCODE_CLI_VERSION` | Optional packaging override for the bundled OpenCode CLI version; defaults to `opencodeCli.version` in `packages/electron/package.json` |
| `OPENCHAMBER_TARGET_ARCH` | Explicit desktop package architecture (`x64` or `arm64`); Linux requires it to match the native host |
| `OPENCHAMBER_DESKTOP_NOTIFY=true` | Enables desktop notification flow in the web server |
| `OPENCHAMBER_SKIP_API_COMPRESSION=true` | Defaulted by Desktop to reduce local CPU overhead |
| `OPENCHAMBER_STARTUP_PERF=1` | Enables privacy-safe startup phase timings in Desktop/server logs; disabled by default |
| `OPENCHAMBER_DESKTOP_USER_DATA_DIR` | Test hook used by `profile:startup`: moves the Electron profile (single-instance lock, Chromium caches) so a measured launch does not share it with the installed app |
| `OPENCODE_HOST` / `OPENCODE_PORT` / `OPENCODE_SKIP_START` | Connect Desktop to an external OpenCode server instead of starting one locally |

Packaged launches using `OPENCHAMBER_DESKTOP_USER_DATA_DIR` skip automatic
login-item registration. An isolated QA bundle must not replace the installed
app's login item or change its opt-out.

## Native Features Owned Here

- Floating Mini Chat windows.
- Mini Chat loads from the resolved local UI origin in HMR development, not the
  API server origin. Bundled mode keeps `openchamber-ui://` assets. Native zoom
  targets the focused window directly; composer focus adjusts interface scale,
  while terminal and file-editor focus adjust their own font sizes.
- New Mini Chat windows default to the managed Chats target. Explicit project/worktree drafts retain their target, existing managed chat sessions reopen in their own directory, and the compact header omits project/branch metadata for Chats. Opening a managed draft back in the main window preserves that target.
- Multiple native windows.
- Native notifications.
- User-confirmed local folder selection. The shared UI supplies the requested directory as the picker `defaultPath`; confirmation is required before filesystem access is retried.
- Theme-file selection uses the local `~/.vscode/extensions` directory when present.
  The local-page-gated `desktop_pick_theme_file` command returns only the selected
  filename, bounded text, and byte size. Its host stays local when the renderer
  connects to a remote API server; remote pages receive no native picker privileges.
- One-click open/reveal/open-in-app actions.
- Desktop host switcher and deep-link imports.
- Local and remote instance handling.
- SSH host import, connections, logs, and port forwarding.
- SSH uses OpenSSH ControlMaster on macOS/Linux. Windows uses independent hidden OpenSSH processes for setup commands and each long-lived forward because Win32 OpenSSH does not support ControlMaster reliably.
- A managed SSH instance runs one server per remote host. The server outlives the SSH session by default (`keepRunning`), so every connect first asks the remote CLI (`openchamber status --json`) what is already running and reuses a server that fits the instance's password. `/api/system/info` is public, so an answer proves nothing about the password: the server has to accept it on `/auth/session`, or have none when the instance has none. Among the servers that fit, a CLI-started daemon of another app version, or one whose bind address no longer matches the instance's network setting, is stopped and replaced. A registered server that is passed over gets a line in the connect log saying why. Foreground servers and servers with another password are neither reused nor stopped. With `keepRunning` off, disconnecting stops an adopted daemon the same way it stops one this session started. The server is shared by every client that fits it, so that stop also ends it for any other client still connected. Starting a server without this lookup leaks one server plus its opencode per reconnect.
- Tunnel lifecycle integration through the web server runtime.
- Remote dev-server previews use a direct WebSocket tunnel when the instance has an HTTP address. Relay-only instances keep the encrypted relay transport in the renderer and bridge its raw bytes to the browser panel through a local Electron listener.
- Auto-update checks, downloads, and restart/apply flow.
- The browser panel's own session (`persist:openchamber-browser`): its storage is
  cleared only through the scoped clear-data command, and camera, microphone,
  location, and device-picker requests from pages shown there are denied. Electron
  grants permission requests by default when no handler is set, and the panel
  loads whatever address the user types. Tab favicons are fetched in this
  session too, so icons behind the page's own login resolve and the app's origin
  never requests anything from a third-party host. Self-signed loopback HTTPS
  pages may use an untrusted certificate authority; certificate failures for
  external hosts and all other certificate errors remain blocked.

## IPC Pattern

### Isolated personal websites

Claude uses a separate durable session, `persist:open-carter-claude`.
`website-guest-security.mjs` denies permission
requests, permission checks and device access on it. Main checks attachment
before guest creation, including the early splash window: the parent must be
trusted local application content using the local API runtime, and the initial
source must match the partition's exact official HTTPS origin. Remote parents
cannot attach to these saved login sessions. Guest preloads are stripped, Node
integration is off, sandbox and context isolation are on, and web security stays
enabled. These sessions are outside the browser-panel controller allowlist.
Popup windows remain denied and links navigate the retained guest in place.

Claude opens `https://claude.ai/` as a website, not an Anthropic API connection.
It retains one guest after first selection and keeps its own sidebar. Full Claude
focuses that same guest without dropping a draft. Home's chooser navigates the
official root in that guest; fresh signed-in chat creation remains unverified.
Explicitly pinned observed URL/title links are device-local, not account/team
history or native transcripts. Account switching remains in Claude. Signed-in
DOM remains unverified, and no automatic conversation capture runs.
No OpenCode content is automatically sent to this website. Web, VS Code, hosted
mobile, Capacitor and remote desktop do not expose this integration.

Renderer code should call the desktop bridge exposed by `preload.mjs`. Do not import Electron from shared UI code.

Add new native capabilities in this order:

1. Add or update the `preload.mjs` bridge only if a new renderer-facing shape is needed.
2. Add the real command handling in `main.mjs` under `openchamber:invoke`.
3. Gate privileged commands in main process logic so remote pages cannot access local filesystem or shell capabilities.
4. Keep shared UI runtime contracts in `packages/ui` and server/runtime APIs in `packages/web` when the behavior is not inherently native.

## Local meetings

`meeting-boundary.mjs` owns meeting IPC authorization and one-use display-media
grants. Only the main window's trusted local main frame, connected to the local
runtime, may invoke `desktop_meeting_*`. Mini Chat, additional windows, child
frames, website guests and remote pages cannot use it. Web, VS Code, hosted
mobile and Capacitor do not expose this native capability.

The private web meeting service owns records and local transcription. Electron
supplies `userData/private-meetings`, separate from project/session data. The
service restricts its files, never persists raw audio, and does not sync records
or upload audio. Hosted dictation settings do not select its backend. Readiness
does not download models. Local capture remains available in enterprise mode.

The IPC contract uses normalized float PCM arrays at 16 kHz mono, at most 90
seconds per chunk. Native accepts one in-flight chunk and clears its input and
converted buffers on success or failure. The renderer owns its streams globally,
outside the meeting view, and drains chunks before normal pause or stop.

- `desktop_meeting_list` returns `{meetings, readiness, capture}`.
- `desktop_meeting_readiness` returns `{available, modelId, reasonCode?}`.
- Create accepts `{title?, calendarEventId?}`. Get, pause, resume and stop accept
  `{id}`; notes accepts `{id, notes}`. Their results are flat meeting records.
- Start accepts `{id, consent: true, mode}` and returns the record plus `capture`.
  Mode is `system-and-microphone` or `microphone`. Microphone-only is explicitly
  degraded; native never silently substitutes it.
- Chunk accepts `{id, source, startMs, endMs, pcm}` and returns the updated record.
  Sources are `microphone` and `system`; transcripts are in `segments`.

Electron's default-session display handler denies requests unless start opened
a 30-second, single-use consent window for that owner frame. Source discovery
is rechecked after awaiting Electron. The candidate grants a screen source and
`loopback` audio on Windows and macOS 14.2 or later. It does not use the system
picker, broaden guest permissions or persist screen content. Renderer keeps the
required video track alive without reading or saving frames. System audio validation is still pending; an eligible
OS does not prove the OS permission, audio track or captured sound works.

Sleep, confirmed quit, document navigation, renderer loss and runtime switching
revoke capture and ask the service to save the partial transcript as interrupted.
Main emits `desktop:meeting-lifecycle` with `{id, reason}` before awaiting disk.
The renderer stops tracks synchronously without flushing interrupted audio.
Capture and save failures include a safe `code` on that event. View navigation
alone does not interrupt recording. The isolated preload also notifies main on
`openchamber:runtime-endpoint-will-change`; that notification can only revoke.

Optional summary IPC is `desktop_meeting_prepare_summary` with `{id, model?}`
and `desktop_meeting_generate_summary` with `{id, model, approvalToken,
approved: true}`. Main supplies authoritative closed-record segments, never
notes or calendar data. The private summary service owns configured small-model
choices, transcript-revision approval tokens and provider generation. Enterprise
mode refuses both operations. Generation returns a meeting only after
revision-checked `saveSummary` succeeds. A missing model/provider is an error or
an explicit unavailable result, not a fabricated summary. Cost and subscription
coverage are unknown; preparing choices sends no transcript.

Mocked native tests live in `meeting-boundary.test.mjs`. They do not capture
microphones, screens, audio or calendar data. HMR, packaged capture, OS permission
prompts and real system audio still require authorized native validation.

## Logs And Data

Electron uses `electron-log`. In development, console logs are also visible in the terminal. In packaged apps, logs are written through the platform log path for the `OpenChamber` app name.

Development builds use a separate user data directory named `OpenChamber Dev`, so dev state does not overwrite normal packaged app state.

## Things To Be Careful With

- Keep desktop-specific code in this package. Do not move OpenCode feature backend logic into Electron.
- Use hidden Windows process launches for background helpers. Avoid visible console flashes.
- Keep `@openchamber/web`, `bun-pty`, `node-pty`, and native modules external in `bundle-main.mjs`; bundling them can break Electron startup. Keep `early-startup.mjs` external too: the entry and main bundles must share its one instance.
- Keep `entry.mjs` small. Anything imported there delays Electron's `ready`; everything else belongs behind the `main.mjs` import.
- Rebuild native modules after dependency or Electron version changes.
- Test both HMR dev mode and bundled UI mode when changing startup, preload, routing, or packaged asset behavior.

## Quick Checks

```bash
bun run type-check:electron
bun run lint:electron
bun run electron:dev:bundled
```

For full repo validation before shipping:

```bash
bun run type-check
bun run lint
```

## Personal homepage

Home's task widget also offers AI Tasks, separate from Daily To-Do. The user can
create a private database with the required workflow or connect an existing one.
Creation does not enable execution. Setup separately opts into sending task
descriptions to the configured OpenCode model and final answers back to Notion.
The coordinator checks every 15 minutes while the desktop app runs. It starts
one Ready for AI card at a time, records the chat before dispatch, and saves the
answer into the original card before marking Done. It never enrolls permission
auto-accept. Each card selects an existing project folder and runs under its
model and manager, with normal approvals. Only a validated read-only Explore
profile can be delegated to in this first slice; wider specialists stay denied.
Run details retain pre-chat failures, results, and real parent/child chat links.
Needs you records failed or blocked answers. Pausing stops pickups, not existing
chat completion. The tracking file and encrypted connection stay local.
The in-process web server owns the coordinator and drains it on shutdown;
durable claims and result markers recover on reopening. No cloud deployment or
Notion credential transfer occurs automatically.
An ambiguous database creation requires checking Notion and pasting its URL,
never automatically creating another database. See
`packages/web/server/lib/ai-tasks/DOCUMENTATION.md` for dispatch and writeback rules.
Web, remote desktop, VS Code, hosted mobile and Capacitor have no native board
controls. Enterprise mode blocks both setup and every Notion request.

Home widgets fill the available workspace. Each column stacks its widgets independently so a tall board does not leave holes beneath shorter widgets. Handles reorder within or across columns with mouse, touch or keyboard. Drag the divider between adjacent columns to adjust their widths continuously. Focus the divider and use Left/Right, Shift for larger steps, or Home/End to reach the limits. Escape cancels an active resize. Columns keep a 240px minimum and stack below 640px of dashboard space. Full width / Column width changes each widget span. Order, spans and fractional width preferences persist locally in `openchamber.personalHome.layout.v2`; existing v1 and v2 layouts migrate to equal columns without changing order or spans. Resize previews stay in memory until released; a failed save leaves the on-screen layout usable and shows an error. Reset layout restores the initial arrangement. This presentation setting does not move Notion pages or events. Hosted MCP update arguments follow its advertised `data` wrapper, and page links normalize to IDs before writes. Calendar accepts ISO times with or without fractional seconds, and the event picker displays calendar names.

Desktop draft mode displays a landscape, live work, recent chats and native personal panels. Existing project/session/rules navigation stays in the sidebar; selecting or sending a chat returns to the ordinary chat workspace. Mobile and VS Code retain the compact draft.

Notion uses the hosted MCP OAuth PKCE connection (encrypted by Electron safeStorage in personal-home.json). Connect is explicit; reads occur when Home opens or Refresh is pressed. Task statuses and habit checkboxes use fetched schema and known page membership. The two personal Home data sources are the defaults; Connections changes their IDs and the saved-chat parent. Chat export is explicit and sends text only, excluding attachments, reasoning and tools. It is not an automatic sync or a Notion document editor.

Task cards display the fetched due date instead of a status select. The board selects a date property named Due or Due date, or the sole date property when there is only one. Ambiguous date fields remain unset. SQL reads the property's start, end and is_datetime columns. IPC carries a nullable due object with the unchanged start/end strings and an isDatetime flag. Calendar days display without timezone conversion; timed dates retain the original time and offset. Missing dates say No due date. Older payloads without due data remain readable.

Board columns retain the configured Notion status names. A dedicated handle moves a card to a column with mouse or a touch long-press; the rest of the card remains scrollable and its controls do not start a drag. The compact Move task action uses the same columns for keyboard access through the shared menu. A move updates status optimistically without changing task order or due data, locks writes while pending, and restores the prior status with an error toast on failure. Successful moves update native cached membership so the next move does not require another board fetch. Refresh stays explicit and cannot overwrite a newer move with an older read. Unknown or missing status cards remain visible but do not create writable invented categories. Authentication, membership validation, local-frame IPC and policy gates are unchanged.

The new Notion egress and loopback OAuth listener are blocked at every request by enterprise mode. Home controls and chat export are disabled/hidden in that mode. Native IPC is limited to the local main application frame. These native connections do not exist in web/mobile/VS Code/remote windows. Calendar stays within EventKit on this machine and remains available in enterprise mode. EventKit may sync saved events through the user's existing Apple calendar accounts.

On macOS, build:personal-home compiles the bundled CalendarBridge.app. It reads the next seven days, creates timed events and edits writable nonrecurring timed events. Recurring and all-day events remain in Calendar. Connect requests calendar access; ordinary reads never prompt. No data is fabricated when disconnected. Tokens and calendar results never enter chat context automatically.

Personal builds display as Open Carter while retaining the legacy app ID, storage directory and encryption identity. Home task creation shares the task widget's heading row instead of reserving a row above the board. Habit names and daily sets remain managed in Notion.

The shared chat transcript keeps a solid top edge beneath the header and retains its bottom composer fade. Home's landscape scrims are unchanged. The main header places Home directly before session tabs, omits Recent Sessions and New session actions, and retains runtime switching. The separate titlebar overlay keeps the sidebar toggle and OS controls. The phone-status header button is omitted; connection and pairing controls remain in Settings.

The personal ChatGPT workspace uses the existing signed-in browser partition. Integrated mode hides the website sidebar and mirrors its loaded conversation/project navigation under the optional ChatGPT website history folder. The website still owns Chat/Work, messages, models, plugins and memory. Full ChatGPT restores the website sidebar. Local pins and chat tabs belong to Open Carter. The DOM adapter is restricted to the exact ChatGPT HTTPS origin and reads navigation metadata without cookies, tokens or application stores. It introduces no IPC, provider API connection or OpenCode context export. Native page isolation and permissions are unchanged. No ChatGPT quota badge or badge-owned polling runs in the header.

Home’s ChatGPT choice uses the normal OpenCode session UI through `lib/chatgpt/native.ts`; see the session sidebar documentation for its dedicated project contract. The website workspace remains a separate full-history option.

Home widgets follow the composer directly, with no starter-chip row or add button; saved starters remain intact for compact drafts.

## OpenRouter rail credits

The right context rail's coin control is the only personal provider balance display. Its
mounted reader refreshes the native feed on mount, focus and every five minutes.
The reader runs with the pane closed and suspends while the rail is hidden.
Remote runtimes and non-Electron clients do not mount it. The optional OpenRouter
menu bar item retains its own timer; the revoked multi-provider billing system
has no readers, IPC commands, management login or polling.
`openrouter-credits.mjs` reads OpenCode's active credential database before its
legacy auth file. Keys stay in native code. It first reads the official `/key`
response; only a confirmed management key may read `/credits`. Inference keys
show only their remaining key limit, not account credit or all-time spending. An
unrestricted inference key shows Balance unavailable in the rail popover; the popover
explains how to connect a management key through its secure password field.
The optional menu bar item never falls back to a spending counter. Missing
fields fail instead of becoming zero. Concurrent refreshes share one request,
same-account failures retain stale values, and account changes clear old values.
Redirects cannot carry credentials to another host. Enterprise policy blocks
billing refresh and added billing keys.
OpenRouter IPC requires the trusted local
main application frame using its local API runtime, not just a local UI origin.

OpenCode's OpenRouter credential may reach the official billing API only when
the SDK confirms the native adapter and no custom gateway override. That
destination guard and IPC authorization live in `openrouter-credits.mjs`.
Account credits and a key's remaining limit are labeled separately. The app
never infers account credit from usage or converts dollars into token estimates.
Provider connections, accounts, model configuration and private meetings are
unchanged. The ordinary native model/agent picker remains available. There is
no special Home credit-pool chooser or multi-provider balance panel.

## Private meetings

`meeting-boundary.mjs` owns meeting IPC authorization and single-use display-media
grants. Main imports the private service from `packages/web/server/lib/meetings`
directly and supplies `userData/private-meetings`. Service creation registers that
directory with the generic file-API exclusion before the local server starts.
There is no meeting HTTP endpoint. Only the trusted local main application frame
can read records, start capture, submit PCM or approve a summary. Remote desktop,
web, VS Code and mobile do not expose this feature. Website guests keep their
existing denied device permissions.

Start requires literal consent and an installed local transcription model. A
system-and-microphone start grants one audio-and-video display request for thirty
seconds. Main returns a screen source with Electron's `loopback` audio option.
The renderer keeps the required video track alive but does not read, store or send
video frames. This is a macOS 14.2+ capture candidate, not verified Teams, Zoom or
headphone compatibility. Capture includes whole-system audio, not a verified
per-meeting filter. Microphone-only is a separate, explicitly degraded choice.
No device or real meeting audio is captured by the tests.

Home and workspace navigation keep the renderer-wide recorder alive. Closing or
hiding its window, switching runtime, document navigation, renderer failure,
sleep and quit revoke capture and save an interrupted partial transcript. The
internal `desktop_meeting_interrupt` command cancels a failed or timed-out start
or chunk without waiting for the normal pause/stop busy gate. Native lifecycle
events clear renderer devices and unsent buffers. Normal pause and stop drain
bounded tail chunks. A damaged saved record produces list warnings without
blocking unrelated records. The app retains no raw audio files.

Summary preparation reads configured small-model choices without uploading text.
Only a later explicit approval token and Generate Summary call send the saved
transcript through OpenCode's sanctioned one-shot generator. Native supplies the
authoritative closed transcript. Notes, title, calendar context and audio are
excluded. Cost and subscription coverage are disclosed as unknown. Enterprise
mode refuses summaries at both native and generation boundaries. Provider keys
and configuration are never exposed or changed by this feature.

The service's persistence and summary contracts are documented in
`packages/web/server/lib/meetings/DOCUMENTATION.md`; the UI capture owner is
documented in `packages/ui/src/lib/meetings/DOCUMENTATION.md`.
`meeting-boundary.test.mjs` tests native gates with mocks, and
`meeting-integration.test.mjs` exercises the real private service and storage with
synthetic worker/provider fixtures. These do not prove OS dialogs, live system
audio, sherpa inference or UI interaction. Those checks remain native QA.

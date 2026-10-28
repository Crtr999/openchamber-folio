# ZDR folder PIN

The optional four-digit PIN protects opening a private folder in the app. It does not encrypt files, hide configured folder names, or secure direct access to the underlying OpenCode server. Home's permanent exclusion is separate and remains active with no PIN and after unlocking.

The server stores a salted PBKDF2 hash and persisted failed-attempt backoff. A successful verification or PIN setup issues a random, process-local access grant valid for ten minutes. Changing/removing the PIN invalidates outstanding grants. Lock now revokes the caller's grant. The renderer keeps the grant only in memory, attaches it through runtime HTTP authentication, closes its curtain at expiry, and discards it on runtime changes. Failed state reads revoke local access rather than assuming no PIN.

The access middleware is installed before feature routes and the OpenCode proxy. Without a grant, it checks directory, file-path, project-ID and session-ID requests before handlers read folder data. Session ownership comes from the existing server session index, not the caller's supplied directory. Unknown ownership fails closed. Named ZDR paths are classified without reading their provider configuration; configured ancestor bindings also protect descendants. JSON session creation bodies are checked before proxy forwarding.

The authenticated state route lists guarded configured directories and reports `pinSet`, `unlocked` and retry delay. Verification/setup return `accessToken` and `expiresAt` on success. `POST /api/openchamber/zdr-lock/lock` revokes the token in `x-openchamber-zdr-access`. Lock responses and PIN results must not be logged or persisted by clients.

Web, Electron, hosted mobile and Capacitor use the same server checks. VS Code has no equivalent backend and shows no PIN control. The grouped sidebar has a folder lock indicator; project editing exposes the existing PIN setup/change/removal controls. Home never displays the private folder as a friend.

`privacy.js` owns transport redaction. Global session lists, activity/status/attention snapshots, SSE, WebSocket live events, replay and OpenChamber control broadcasts exclude private owners even when the client holds a valid grant. Unknown event/session ownership fails closed. Mixed worktree references lose private directories before serialization. The middleware is registered immediately after API authentication, before notification and feature routes.

An unlocked conversation explicitly requests a private event directory through `x-openchamber-zdr-directory`. The sync pipeline uses the shared SDK HTTP/SSE transport for this subscription, reconnects on directory or lock changes, and returns to the global transport on relock. The server checks the current grant for each private SSE frame. Global requests without that explicit scope remain redacted. Directory WebSockets reject private folders and recheck event ownership before delivery because browser upgrades cannot carry a PIN grant.

Path comparisons use filesystem canonical identities, including configured aliases, case on case-insensitive filesystems, dot segments and symlinks. Missing descendants resolve through an existing ancestor. Filesystem failures deny access. Policy decisions are bounded and invalidated by config events and completed config, filesystem or project mutations. Symlinks are resolved before consulting cached policy. PIN state responses include configured and canonical guarded roots.

| Runtime | Behavior |
| --- | --- |
| Web | Server gates, memory-only grant, explicit private SSE, lock curtain |
| Electron | Same server and shared UI behavior |
| Hosted mobile | Same HTTP/SSE gates through runtime relay transport |
| Capacitor | Same HTTP/SSE gates through runtime transport |
| VS Code | No PIN backend or controls, existing workspace scope remains unchanged |

`privacy.test.js` exercises real loopback HTTP proxy/status routes plus synthetic SSE fragmentation, grant revocation, aliases and WS replay/live delivery. `ZdrLockCurtain.test.tsx` exercises the actual curtain and store with a synthetic runtime response. These tests never open a real private folder or attempt a live PIN. Installed-app screenshots, a live encrypted relay and native calendar IPC are not covered by these fixtures. This PIN is an app access boundary, not protection from a process that directly reads disk or calls the underlying OpenCode server.

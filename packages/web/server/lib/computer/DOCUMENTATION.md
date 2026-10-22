# Computer

The agent's computer, inside the app.

## What it is

Open Carter does not own a computer. A tool brings one — the CarterBot
computer is the one this build ships with — and that tool's MCP server is
already configured, so the address of its control centre and the key that
opens it are both in the tool's own configuration.

This module finds that configuration, resolves the key, and hands back the two
things the app needs: the address to show, and the credential to show it with.

The key is written in the configuration as a `{file:...}` reference, so it
never appears in a file the user might share, and it never leaves this
process: the browser panel is given it as a cookie, and the renderer never
sees it.

## The pieces

| Piece | Owns |
| --- | --- |
| `server/lib/computer/endpoint.js` | finding the computer: the address, the key, and clipboard sync (`sendComputerClipboard`) |
| `server/lib/computer/routes.js` | `GET /api/computer/state` and `POST /api/computer/clipboard` |
| `packages/electron/main.mjs` | setting the panel's cookie and permitting clipboard access for the local computer origin |
| `packages/ui/src/components/computer/ComputerPane.tsx` | the list of screens, the embedded screen view, and zoom/clipboard integration |
| `packages/ui/src/components/computer/computerViewBridge.ts` | trackpad pinch-to-zoom, ordinary wheel scrolling at every zoom level, Alt+wheel panning, in-place Take over toggling, and host-to-VM clipboard paste/copy |

## The screen

The control centre is a web page, and the screen it shows is a live view of
the computer. So the way to show the computer inside the app is to open that
page in the app's own browser panel: the same panel every other page uses,
with the key already set as a cookie, so nothing secret is in an address bar
and nothing has to be proxied.

The pane is the way in. It lists the screens the computer has open and opens
the one the user picks. Inside the screen view:

- **Pinch-to-zoom and panning**: Trackpad pinch (`wheel` with `ctrlKey`/`metaKey` or WebKit gesture events), `⌘/Ctrl` + `+`/`-`/`0`, and toolbar `−` / `100%` / `+` buttons scale the live VNC viewport from `100%` (fit) up to `500%` anchored at the pointer while keeping `noVNC`'s internal canvas scale synchronized so clicks and typing remain pixel-accurate. When zoomed in (`> 100%`), ordinary wheel/two-finger scrolling reaches the remote webpage. Alt+wheel explicitly pans the magnified desktop.
- **In-place Take over & Copy/Paste**: Toggling `Take over` flips `UI.rfb.viewOnly` in place without tearing down the VNC frame or resetting zoom. While controlling the computer, pasting via `⌘V`, `Ctrl+V`, `Edit → Paste`, or the toolbar `Paste` button syncs host clipboard text into the screen's X11 `CLIPBOARD` and `PRIMARY` selections (`xclip`) and dispatches `Ctrl+V` (`xdotool`), and copying inside the screen syncs text back to the host clipboard.

## Desktop handoffs

The Mac `show_screen` helper routes a screen name through
`openchamber://computer/<screen>` to the installed app. The local desktop
renderer reveals its persisted singleton Computer tab and selects that screen.
Remote runtimes ignore the local screen notification. Other runtimes retain
their existing Computer view.

The local Electron view uses the browser partition’s Chromium webview, avoiding
cross-site iframe cookie restrictions. Other runtimes keep the iframe view.
Electron sets the HttpOnly computer cookie in both app and browser sessions
using its `no_restriction` SameSite enum, corresponding to SameSite=None.
Credentials stay out of deep links and renderer notifications. Selecting a
screen does not take over the computer or complete a handoff. The separate
browser window remains a fallback when the Mac has no installed Open Carter.


## Local computer desktop and recovery

CarterBot ships a lightweight Openbox desktop with a file manager, terminal,
text editor and task panel per virtual display. Its Computer toolbar opens Home,
the existing Browser, Files, Terminal and Text Editor. These remain isolated in
CarterBot; no host Mac filesystem or native-app privilege is added.

The authenticated CarterBot server appends a same-origin `globalThis.UI = UI`
adapter only to its installed noVNC `/app/ui.js` module. This exposes the actual
controller to its owning parent view for input, scale and connection state.
Errors remain visible; the toolbar reports the viewer connection and reconnects
only the iframe, preserving the computer and browser. Stock noVNC also retains
its existing reconnect behavior. An unavailable frame is not evidence that the
model can see the screen; non-vision models should use browser DOM tools.

Generated credentials use CarterBot's separate local encrypted vault. A request
shows the exact HTTPS site and username in the authenticated Computer view;
only a user click generates and saves the password. Agent tools return metadata
and IDs, and autofill checks the document and form origin before assigning each
field. Submission remains separately approved; existing passwords, verification
codes, CAPTCHA and payment details retain handoff. This cannot change a model
provider's refusal policy. The encryption key and records live in the isolated
computer's persistent data directory; filesystem access to both can decrypt them.

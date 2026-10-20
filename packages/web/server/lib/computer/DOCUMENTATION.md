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
| `server/lib/computer/endpoint.js` | finding the computer: the address, and the key |
| `server/lib/computer/routes.js` | `GET /api/computer/state` — which screens are open |
| `packages/electron/main.mjs` | setting the panel's cookie, so no key is ever in a URL |
| `packages/ui/src/components/computer/ComputerPane.tsx` | the list of screens, and the way into one |

## The screen

The control centre is a web page, and the screen it shows is a live view of
the computer. So the way to show the computer inside the app is to open that
page in the app's own browser panel: the same panel every other page uses,
with the key already set as a cookie, so nothing secret is in an address bar
and nothing has to be proxied.

The pane is the way in. It lists the screens the computer has open and opens
the one the user picks.

## What it will not do

- **It will not write to the computer.** The app only reads the state and
  shows the screen; every action on the computer is the tool's business, and
  the tool asks the user first.
- **It will not reach another machine.** The computer is a local one: the
  configuration's address has to be this machine's.
- **It will not fail the app when the computer is not running.** A computer
  that is not there is an ordinary state, reported as "not available".

## What is not proven

The endpoint resolution has been run against this machine's real
configuration — the address and the key resolve, and seven screens are
reported. The browser panel's cookie has not been exercised end to end in
this repository's test suite: the tests cover the resolution and the state
read, which are the parts that can be wrong quietly.

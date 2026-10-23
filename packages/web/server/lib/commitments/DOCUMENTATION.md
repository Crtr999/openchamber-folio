# Commitments

A personal list of things that are due, noticed from the user's own chats, with unprompted, deadline-aware follow-ups. There is no screen, card or settings page. Follow-ups arrive as a conversation in the folder (friend) the commitment came from, and the user manages the list by talking: "what's due?", "that's done", "push it to Friday", "stop tracking that". The list lives in one local file, `<data dir>/commitments.json`.

## Enterprise boundary

No new egress or exposure path is added.

- Conversation text goes only to the model provider the user already configured, through OpenCode, using the same small-model client as session memory capture. It honors a folder's provider binding.
- Delivery reuses the existing notification fanout (desktop, in-app, web push, APNs where configured). Nothing new is sent to a third party. Native phone push still needs the user's own Apple Developer membership and APNs key; see `notifications/APNS.md`.
- Management is the `commitment.list|add|update|remove` actions of the managed `openchamber` agent tool (`actions.js`), served by the existing control callback. No HTTP routes or UI events were added.
- The only web access is the stock `websearch`/`webfetch` tools inside a check session, and only for items with `research: true`.
- No listener, endpoint or provider fallback is added. Routes sit behind the existing API authentication.

Surfaces: none of its own. It works wherever the app's chats and notifications work (web, Electron, hosted mobile, Capacitor). VS Code has no managed agent tool here.

## Never tracked: ZDR folders

`zdr-guard.js` runs before any message is read and before any check is dispatched. It fails closed. A directory is refused when any of these holds:

- no directory is known;
- its path contains `zdr` (any case);
- its provider binding is unreadable or restricts to any provider binding, including `openrouter-zdr`;
- the settings file is unreadable;
- it is, or is inside, a folder listed in `excludedDirectories` (a file setting, no screen).

Only ZDR is segregated. The same guard gates the agent actions, so a ZDR conversation can neither read nor change the list. Follow-up conversations are skipped by capture and by memory capture.

## Capture

`capture-runtime.js` listens for `session.idle` (debounced 30 s), asks the small model for up to three dated commitments from settled turns, and adds them as `origin: auto`. Anything stale, malformed, injection-like or undated without a watch is dropped. Auto items stay silent for 24 hours unless the user keeps them, so a wrong guess can be removed before it ever nudges.

## Checks and follow-ups

`check-runtime.js` ticks every 10 minutes (first after 45 s). It skips when disabled, in quiet hours (21:00 to 08:00 by default), over the daily limit (3 by default), or while another check runs. It picks the nearest due item, claims `lastCheckedAt` before dispatch, and opens a conversation in the item's source folder (a tucked-away folder when there is none). Cadence (`cadence.js`) widens with distance: 12 h inside a day, daily inside a week, then 84 h and weekly; watches force at most daily. Overdue items are asked about once. Auto-added items stay silent for 24 hours unless the user confirms them by acting on them.

The agent answers in at most 280 characters or returns `[CARTER_NO_UPDATE]`. `decide.js` drops empty, repeated or suspicious replies. Only a real follow-up counts toward the daily limit and is delivered; first quiet decisions archive their conversation. The check is told to change nothing. When the user replies in that conversation the agent may use the commitment actions. The session's permissions allow only the `openchamber` tool plus web search and fetch (research items), and the control service refuses every non-commitment action from an enrolled follow-up session. Residual risk: a fetched page that injects instructions could mark an item done or snooze it; it cannot reach anything else.

## Research privacy

Items that look private, work-related or legal get `research: false`, so their check sessions have no web tools and nothing from them can reach a search query. Research prompts also forbid names and case numbers in queries and cap searches at three.

## Validation

Vitest covers the store, guard, cadence, decision rules, extraction, check and capture runtimes, and the agent actions. Control-service tests cover the follow-up session restriction. Not proven by tests: live OpenCode client behavior and a real phone receiving a push. Those are release gates.

# Commitments

A personal list of things that are due, noticed from the user's own chats (or added by hand), with unprompted, deadline-aware check-ins. The list lives in one local file, `<data dir>/commitments.json`, and is managed only from the Home card.

## Enterprise boundary

No new egress or exposure path is added.

- Conversation text goes only to the model provider the user already configured, through OpenCode, using the same small-model client as session memory capture. It honors a folder's provider binding.
- Delivery reuses the existing notification fanout (desktop, in-app, web push, APNs where configured). Nothing new is sent to a third party. Native phone push still needs the user's own Apple Developer membership and APNs key; see `notifications/APNS.md`.
- The only web access is the stock `websearch`/`webfetch` tools inside a check session, and only for items with `research: true`.
- No listener, endpoint or provider fallback is added. Routes sit behind the existing API authentication.

Surfaces: web, Electron, hosted mobile and Capacitor show the Home card and receive the same server routes. VS Code has no card and no route bridge.

## Never tracked: ZDR and legal folders

`zdr-guard.js` runs before any message is read and before any check is dispatched. It fails closed. A directory is refused when any of these holds:

- no directory is known;
- its path contains `zdr` (any case);
- its provider binding is unreadable, or restricts to any provider binding including `openrouter-zdr`;
- the settings file is unreadable;
- it is, or is inside, a folder the user excluded.

The "never tracked" list in settings can only add folders. It cannot remove the ZDR/legal rule. Sessions the feature itself creates (checks, companion runs) are skipped too, and the check folder is excluded from memory capture.

## Capture

`capture-runtime.js` listens for `session.idle` (debounced 30 s), asks the small model for up to three dated commitments from settled turns, and adds them as `origin: auto`. Anything stale, malformed, injection-like or undated without a watch is dropped. Auto items stay silent for 24 hours unless the user keeps them, so a wrong guess can be removed before it ever nudges.

## Checks and nudges

`check-runtime.js` ticks every 10 minutes (first after 45 s). It skips when disabled, in quiet hours, over the daily limit, or while another check runs. It picks the nearest due item, claims `lastCheckedAt` before dispatch, and runs a check session whose permissions deny everything except web tools for research-enabled items. Cadence (`cadence.js`) widens with distance: 12 h inside a day, daily inside a week, then 84 h and weekly; watches force at most daily. Overdue items are asked about once.

The agent answers in at most 280 characters or returns `[CARTER_NO_UPDATE]`. `decide.js` drops empty, repeated or suspicious replies. Only a real nudge counts toward the daily limit and is delivered; first quiet decisions archive their session. The agent can never mark an item done: `store.patch` accepts only user fields.

## Research privacy

Items that look private, work-related or legal get `research: false`, so their check sessions have no web tools and nothing from them can reach a search query. Research prompts also forbid names and case numbers in queries and cap searches at three.

## Validation

Vitest covers the store, guard, cadence, decision rules, extraction, check and capture runtimes, and routes. UI tests cover the date labels, the 13-language copy (keys and placeholders) and the layout. Not proven by tests: live OpenCode client behavior and a real phone receiving a push. Those are release gates.

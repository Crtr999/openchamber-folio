# Open Carter app context

## Personal additions

Open Carter is Carter's personal operating system and second brain, built by customizing OpenChamber. The source keeps upstream package names and documentation. Read current implementations before describing exact behavior or attributing a feature to a particular pass.

The personal Home dashboard combines Friends, running work, pinned/recent chats, projects, shortcuts, a Notion task board, Notion daily habits, calendar events and Markdown chat export. Its widgets support saved ordering and full/half widths. Add-task controls sit at the top of the task board; hover controls do not reserve a blank header row. Start at `packages/ui/src/components/chat/HomeDashboard.tsx`, `HomePersonalPanels.tsx`, `HomeWidgetLayout.tsx` and `HomeDashboard.css`. Native Notion/calendar/export behavior lives in `packages/electron/personal-home.mjs` and the shared client in `packages/ui/src/lib/personal-home.ts`.

Friends is a Home widget and unified folder identity (`1 folder = 1 friend`): each folder is a Friend card with a generated avatar (body + theme color), Friend name, role, active guardrail badges, and a live status line across all conversations in that folder. Clicking a card continues that folder Friend's latest conversation in the focused tab, while `+` starts a separate sub-conversation in that folder that inherits the Friend's built-in Operator capabilities, `AGENTS.md` rules, `MEMORY.md` shared memory, and `opencode.json` guardrails. Details & Guardrails opens a unified Studio panel for the folder's sub-conversations, ZDR/capability guardrails, `AGENTS.md` rules, `MEMORY.md` memory, what the friend remembers, and team work; Customize edits name, role, body, and color, stored per runtime under `open-carter:friends:v1` and mirrored in the left sidebar. See `packages/ui/src/components/chat/FRIENDS.md`.

A friend also learns on its own. The memory feature is on by default in this build: `agent-memory` keeps what is remembered per project, `openchamber_memory` lets the agent save something by its own initiative, and `session-memory-capture` distils a conversation that has ended into the folder's project memory so the next conversation in that folder is told about it. The capture writes only to the project the conversation ran in, never to global memory, never to the user's own `MEMORY.md`, and never through a provider the folder did not use. It is a setting of its own (`folderMemoryAutoCapture`); the whole feature can be taken away with `OPENCHAMBER_MEMORY_ENABLE=0`. See `packages/web/server/lib/session-memory-capture/DOCUMENTATION.md`.

All Chats is a friend as well. The conversations that belong to no folder live under the app's own chats root, one dated directory each, and they are one friend named General until the user renames it. Its memory is its own project scope, so what is settled in All Chats is not carried into any folder; the only memory every project shares is the global one, about the user rather than the work. When the user renames it, the sidebar's All Chats heading says that name. See `packages/ui/src/components/chat/FRIENDS.md`.

The agent's computer is a surface in the app. A tool brings a computer — the CarterBot computer is the one this build ships with — and that tool's configuration says where it is and how to open it. The Computer surface lists the screens the computer has open and opens the one the user picks in the app's own browser panel, with the key set as a cookie on that panel's session so nothing secret is ever in an address bar. The key never reaches the renderer. See `packages/web/server/lib/computer/DOCUMENTATION.md`.

The friend's face in the sidebar is large enough to read, and the Customize dialog shows the folder's whole memory — every entry, editable and removable, the same editor the Memory tab uses — next to the name, the role and the face. The store is pointed at that friend while the dialog is open and put back on the way out.

While a folder is working, its icon in the left sidebar moves and the friend's face on the Home card moves with it. Both read the shared live status index, and both stop for anyone who has asked for reduced motion.

Daily habits can be checked off through the existing Notion integration. Weekday habit scheduling and an in-app habit-list editor were deferred by Carter. Inspect the current implementation rather than promising those features.

Home no longer mounts the ChatGPT task card or its focus-triggered reads.
The retained read-only automation reader reads ChatGPT/Codex automations from
`~/.codex/automations/<id>/automation.toml` and shows each job's name, its
human schedule in the Mac's local zone, its ACTIVE/PAUSED status and its thread
id. `packages/electron/chatgpt-automations.mjs` owns the read (strict flat-TOML
reader, zod validation, rrule summary, deterministic sort) and returns
`{ rows, readAt, partial, skipped, error? }` through the existing
`desktop_personal_home` channel and `chatgpt-automations-list` action, behind the
same trusted-local main-frame gate as the team bridge. `packages/ui/src/lib/personal-home.ts`
is the client and `packages/ui/src/components/chat/HomeChatGPTTasks.tsx` the card.

Open Carter never creates, edits, pauses, resumes, deletes or runs one of these
jobs, never writes under `~/.codex`, and never turns an external row into a local
schedule. ChatGPT ids stay `providerJobId`/`providerThreadId` and are never
merged with local project/task ids. No thread URL is derived because no ChatGPT
thread link scheme has been verified. An uncomputable next run displays as
unknown; unreadable files make the read partial rather than empty; a failed read
keeps the last good rows beside the error in the retained card component. This
component is not part of Home. See `packages/ui/src/components/views/account-integration-findings.md`
for what this feed does and does not prove.

The jobs themselves are executed by the ChatGPT desktop app's own scheduler, not
by Open Carter. When that app is closed, ChatGPT reports the Mac as offline;
Open Carter never emits that message and nothing here depends on the jobs
running — the reader only mirrors the files. If the jobs must fire, keep the
ChatGPT app running (it is not currently set to open at login).

Meeting recording starts from Home, the search palette ("Start meeting notes") or a calendar event in the trusted local desktop window. The workspace is a Notion-style meeting-notes page (meeting list, Summary/Notes/Transcript tabs, autosaved notes) and a floating bottom pill shows the timer, live level, pause and stop while recording. After the first reviewed summary, the chosen model and its transcript-only disclosure are remembered (`open-carter:meeting-summary-model`/`-ack`), and later recordings summarize automatically on stop through the same prepare/approval-token/generate flow; "Change model" forgets it. Inspect `packages/ui/src/lib/meetings/DOCUMENTATION.md`, `packages/electron/meeting-boundary.mjs` and `packages/web/server/lib/meetings/DOCUMENTATION.md` for consent, capture lifecycle, private local transcripts/notes and deliberate transcript-only summary approval. System audio is an Electron capture candidate, not verified Teams/Zoom or headphone compatibility. iPhone call recording is unsupported. Meeting transcripts are separate from chats and are not automatically uploaded, searched or exported. Calendar and Notion reminders were not added by the meeting implementation.

Chat search opens from the left sidebar or its existing search shortcut, loads results as Carter types, and leaves the app usable. Outside pointer clicks and Escape close the panel and cancel queued/in-flight reads. It uses the existing active-runtime global session scan, not website account history; project/date/model/attachment filters and the 200-result cap remain. See `packages/ui/src/components/layout/ChatSearchPanel.tsx`.

Project instructions and configuration can be edited from the Rules view, with revision checks and a previous-version restore. See `packages/ui/src/components/layout/ProjectRulesEditor.tsx` and its file API implementation before changing save behavior.

Native ChatGPT uses the standard OpenCode composer, session history, project controls, OpenAI models and reasoning effort. Start at `packages/ui/src/lib/chatgpt/native.ts`. The desktop header shows a subscription-usage cluster for the configured native plans (`SubscriptionUsageMeters`): ChatGPT, Grok, and Claude. Each logo has an outer ring for the weekly or 7-day window and an inner ring for the 5-hour window when the provider reports one. Hover or click a logo to open the used and remaining percents; click pins the readout until Escape or a click outside. Grok's subscription reports a single billing-cycle pool, so it has one ring. The cluster reads the existing `/api/quota` providers (`codex`, `xai`, `claude`); it does not poll chatgpt.com or own a separate credential. Its ordinary chats are stored separately from the optional signed-in ChatGPT website wrapper. The website wrapper retains website history and account features; it has its own folder and tools. See `packages/ui/src/components/session/sidebar/shell/ChatGPTFolder.tsx` and `packages/ui/src/components/views/ChatGPTWorkspace.tsx`. Native chats do not sync into chatgpt.com or inherit its account memory. Claude Team integration remains future work.

The optional Claude website opens `https://claude.ai/` in its own retained guest and `persist:open-carter-claude` sign-in partition. This uses the user's Claude website subscription, not Anthropic API billing or a native model connection. Claude owns its history and account features; signed-in DOM has not been verified, so no history adapter runs. Start at `packages/ui/src/components/views/ClaudeWorkspace.tsx` and `packages/ui/src/stores/useClaudeStore.ts`. Claude is local Electron only; `packages/electron/website-guest-security.mjs` enforces trusted local attachment, removes guest preload privileges and denies device permissions. Remote pages cannot use these account partitions.

Header tabs behave like Notion tabs. `useSessionTabsStore` keeps the persisted tab list plus the focused tab; opening a chat or website anywhere replaces the focused tab in place (`navigateTab`), and only the + button, ⌘T, ⌘↵ in the palette, or a sidebar row's "Open in new tab" add a tab (`requestNewTab`). Home is not a tab: it highlights the Home button and keeps the focused tab for the next navigation. Tabs share the strip width (no edge fade) and scroll only past their minimum width. The + button opens `NotionSearchPalette` ("Open in new tab…"), which also replaces the sidebar search: instant title matches, streamed message-content matches with highlights, and a live preview pane; its filter button opens the older advanced `ChatSearchPanel`. Header tabs use the persisted `useSessionTabsStore` for open native sessions and singleton website tabs. Electron's version-22 UI preference migration enables the existing session-tabs option for this personal build; later explicit choices remain respected. Tab selection switches existing content without creating sessions. Home sits directly before the tabs; New session, Recent Sessions and phone-status header actions are omitted. Runtime switching retains remote context. The titlebar overlay keeps the sidebar toggle and OS controls. See `packages/ui/src/components/layout/Header.tsx`, `SessionTabsStrip.tsx` and `packages/ui/src/lib/sessionTabs.ts`.

The right context rail's OpenRouter coin control uses the official native feed in `packages/electron/openrouter-credits.mjs` through `packages/ui/src/components/layout/OpenRouterBalanceBadge.tsx`. It opens remaining dollars and secure management-key setup, never a spending counter or token estimate. Its reader runs while the rail is mounted, including with the context pane closed; hiding the rail suspends it. There are no other provider balance readers or special credit-pool choosers. Provider connections and the normal native model/agent picker remain intact. Personal desktop features need explicit behavior for other runtimes; read the owning docs before editing them.

## Inspection and edits

Home widget dragging disables CSS transitions on the actively dragged card so
its transform follows pointer, touch and keyboard input directly. Other cards
keep their sortable placement transitions. MainLayout does not fade the entire
main view on chat or website navigation; content appears at full opacity when ready.

Tactile polish (button press springs, sidebar current-row marker, Home card
hover shadows, composer focus glow, tab close slide) lives in
`packages/ui/src/styles/open-carter-feel.css`, scoped to the desktop shell and
switched off under reduced motion. It moves only transform and opacity, never
transforms sortable wrappers, and leaves tab activation as an instant snap. A
closing header tab leaves the store immediately; a detached copy fades in its place.

The print-poster look lives in `packages/ui/src/styles/open-carter-vibe.css`.
The default themes `openchamber-light`/`openchamber-dark` were retuned in place to
the "Open Carter" palette (cobalt ink on cream; cream on ink black, cobalt accent);
the previous palette stays selectable as "OpenChamber Classic"
(`openchamber-classic-*`). `cssGenerator` sets `data-theme-id` on `<html>` so the
grain and cobalt hairlines apply only to the Open Carter themes. Fonts are bundled
OFL packages imported by `useAppFontEffects.ts`: Plus Jakarta Sans (default UI font;
UI store v27 moves the old `system` default on desktop), Archivo (wide, heavy widget
titles, `--oc-font-display`) and Instrument Serif (Home greeting, `--oc-font-serif`).
Home scenes are bundled in `components/chat/homeScenes.ts` (engraved coast default,
night coast duotone, cloud sky, stipple night); the greeting's palette button cycles
them and stores the choice in `localStorage` (`openCarter.homeScene`).
The scene is one window-wide fixed layer (`HomeSceneBackdrop` in MainLayout). While
Home shows, `useHomeSceneActive` sets `data-oc-home` on `<html>`: the canvas layers
around the Home content turn transparent and the sidebar, header and context rail
become frosted washes over it; elsewhere the scene drops to a 40% tint seen only
through those panes.

The desktop titlebar spans the whole window above the sidebar and chat. It reserves
only native window-control clearance and the measured sidebar-toggle footprint,
so Home and session tabs do not shift to the sidebar's right edge when it opens.
The task board's New Task control is compact until activated; its editor retains
nonempty drafts and collapses after empty blur or Escape. See `HomeTaskComposer.tsx`.

For an app review, first read this checkout's `AGENTS.md`, `README.md`, `packages/electron/README.md`, and the files relevant to Carter's request. Follow root routing to project skills and nearest module documentation before editing. A context note is orientation; a source review is complete only after successful file reads.

For app state, inspect the tools actually available in this session. The `openchamber` control tool belongs to this Open Carter app despite its upstream name. Its read-only `projects.list` and `session.list` actions can inspect configured projects and chats. Consult `packages/web/server/lib/agent-tool/DOCUMENTATION.md` for capabilities. `openchamber_web`, when enabled, controls the app's browser panel. These tools are not general desktop screen access. Distinguish source facts, tool observations and unavailable visual details in replies.

## Meetings, reminders and previews (Oct 2026 pass)

Meetings can be renamed inline (`desktop_meeting_rename` → `service.rename`). A finished meeting offers "Discuss in chat" (opens a Home draft with the meeting as `initialPrompt`; only on that explicit click) and "Send to Notion" (reuses the saved-chats `export` action). `MeetingReminders.tsx` reads Apple Calendar every 5 minutes and, from 2 minutes before to 5 minutes after a timed event starts, shows a card and a system notification asking to record; yes starts meeting notes titled and linked to the event. Stop/pause tolerate a slow transcriber shutdown when the record is already saved. Scrollbars auto-hide via `data-oc-scrolling` (MainLayout + index.css). `.docx` files preview read-only in Files through `DocxArtifact.tsx` (docx-preview); PDFs use Chromium's viewer (`plugins: true`).

## Version 1.0 (final)

Open Carter 1.0 is the finished personal build; changes after this are fixes, not features. The macOS About panel reads "Open Carter 1.0" (the package version stays upstream's for compatibility). It launches at login once by default (a `open-carter-login-default` marker in userData keeps a later opt-out) and opens visibly. Ordinary launches land on Home while tabs persist. Explicit `?session=` links and reloads keep the requested chat; `MainLayout.tsx` captures that intent before startup effects run. Home never shows a scrollbar. Meeting summaries offer "Add to To-Do", which creates Notion Daily To-Do tasks from checkbox lines or bullets under an action-items/next-steps heading. The ⌘⇧M meeting shortcut was removed. Known environment issue: five upstream `server/lib/git/service.test.js` worktree tests time out on this Mac; they are unrelated to Open Carter changes.

## 1.1: Today card and morph motion

`TodayCard.tsx` (inside `NotionSearchPalette`, action "Today", or `openTodayCard()`) shows today's Apple Calendar events and Notion tasks due today or overdue; Record starts meeting notes for an event, and ticking moves the task to the board's done column. It opens once per day on first launch/focus (`open-carter:today-shown`). Motion helpers live in `lib/motion.ts` (morphFrom/morphInto/collapseAway/reshapeFrom, all disabled under reduced motion); confirmations use `showPill()` from `lib/pill.ts` rendered by `PillToaster`. The meeting pill grows into the meeting window and, while recording, the window shrinks back into the pill; the calendar prompt unfolds from a dot and folds into the pill.

## Commitments

No screen. Deadlines you mention in a chat are noticed and followed up on in that friend/folder's own chat, within quiet hours and a daily limit; you answer there ("done", "push it to Friday") and any chat can list or change them. Stored locally in `commitments.json`; only ZDR folders are excluded. Details: `packages/web/server/lib/commitments/DOCUMENTATION.md`.

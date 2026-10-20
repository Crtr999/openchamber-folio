# Friends (1-to-1 Folder = Friend)

Friends is the `friends` widget on Home and the unified identity across Open Carter's
folders: each folder is a Friend with built-in Operator capabilities, its own
personality (`AGENTS.md`), shared folder memory (`MEMORY.md`), folder-level
guardrails (`opencode.json`), and a memory that carries what the folder's
earlier conversations worked out.

## Surface

`HomeFriends.tsx` renders one Friend card per configured project folder:

- Header (`HomeFriendsHeader`): title, folder-friend count, `"1 folder = 1 friend"`
  indicator, and an icon-only refresh.
- Cards (`HomeFriendCards`): generated `HomeFriendAvatar` (body + theme color),
  Friend name, role/specialty, active guardrail pills (such as `ZDR Locked`,
  `Virtual Computer`, `Local Only`), and a live status line across all
  conversations in that folder (working/retrying, latest active time + chat
  count, or description).
- Clicking a card continues the folder's latest or linked conversation. The
  card's `+` button and menu `New conversation` start a separate sub-conversation
  in that folder; every conversation in the folder inherits the folder Friend's
  capabilities, `AGENTS.md` rules, `MEMORY.md` memory, and `opencode.json`
  guardrails.
- Details & Guardrails (`HomeFriendDetails.tsx`) opens the unified Friend &
  Folder Studio panel:
  - Recent sub-conversations in the folder for one-click switching.
  - Interactive **Brain, Capabilities & Guardrails** studio: Strict ZDR Endpoint
    Lock (`openrouter-zdr`), Folder Friend Agent selector (`operator`, `zdr`,
    `ChatGPT`, `Claude`, etc.), default model, and per-capability guardrails
    (Virtual Computer / CarterBot, Mac App Control, Browser Automation, Web
    Search & Fetch, File Edits & Shell, Outside Folder Access, Specialist
    Subagents).
  - Inline editors for **Folder Rules & Personality (`AGENTS.md`)** and **Shared
    Friend Memory (`MEMORY.md`)** with revision checks and previous-version
    restore.
  - **What this friend remembers** (`FriendMemorySection.tsx`): the entries the
    folder has accumulated, read from the same store the agent is told about.
  - Folder Specialists & background **Team Work** (`HomeFriendsWork`).
- Customize (`HomeFriendCustomize.tsx`): edits Friend name, role/specialty, body
  shape, and theme color, persisted under `open-carter:friends:v1:<runtime>` and
  synced with the left sidebar folder header.

## What a friend remembers

Two memories, and they are not the same thing.

`MEMORY.md` is the user's: their own file, edited by hand, read by the folder's
rules. It is never written by the app.

The store behind `openchamber_memory` is the agent's. Every conversation in the
folder contributes to it: when a conversation ends, `session-memory-capture`
distils the turns since the last capture and writes what was settled into the
folder's project memory. `session-knowledge` then tells every later session in
that folder the titles of what is stored, so the next conversation there starts
with the earlier ones. See
`packages/web/server/lib/session-memory-capture/DOCUMENTATION.md`.

The capture is a setting of its own (`folderMemoryAutoCapture`), and the whole
memory feature can be taken away with `OPENCHAMBER_MEMORY_ENABLE=0`.

## While a friend works

The folder's icon in the sidebar moves while any conversation in that folder is
working, and the friend's face on the Home card moves with it. Both read the
shared live status index, so they are the same fact shown twice. The motion
stops for anyone who has asked for reduced motion.

Brain-only saves preserve existing provider policies and granular permission rules. Capability controls replace only the categories explicitly changed. Conversation continuation re-reads the actual session and requires the exact folder and its configured primary agent; a nested folder remains a separate Friend. Configured primary agents, including manager, take precedence over the generic Operator fallback.

# Friends (1-to-1 Folder = Friend)

Friends is the `friends` widget on Home and the unified identity across Open Carter's
folders: each friend owns its folder, with built-in Operator capabilities, its own
personality (`AGENTS.md`), the folder's memory (`MEMORY.md`), folder-level
guardrails (`opencode.json`). Every chat in the folder is added to that folder's memory.

## Surface

`HomeFriends.tsx` renders one Friend card per configured project folder:

- Header (`HomeFriendsHeader`): title, folder-friend count, `Each friend owns its folder`,
  and an icon-only refresh.
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
  The dialog also shows what this friend remembers: the folder's whole memory,
  editable and removable, in the same editor the Memory tab uses. The store is
  pointed at that friend while the dialog is open and put back on the way out,
  so the Memory tab beside it still shows the project the user is working in.

## What a friend remembers

Two memories, and they are not the same thing.

`MEMORY.md` is the user's: their own file, edited by hand, read by the folder's
rules. It is never written by the app.

The store behind `openchamber_memory` is the friend's. The friend owns the folder
and takes charge of remembering it. Every chat in the folder is added to the
folder's memory: when a chat ends, `session-memory-capture` distils the turns
since the last capture and writes what was settled into that folder's memory.
`session-knowledge` then tells every later chat in that folder the titles of
what is stored, so the next chat there starts with the earlier ones. See
`packages/web/server/lib/session-memory-capture/DOCUMENTATION.md`.

The capture is a setting of its own (`folderMemoryAutoCapture`), and the whole
memory feature can be taken away with `OPENCHAMBER_MEMORY_ENABLE=0`.

## All Chats is a friend too

A conversation that belongs to no folder still belongs to somebody. Those
conversations live under the app's own chats root — the server reports it, and
each conversation gets a dated directory of its own inside it — and they are one
friend, not a pile of folders.

- The friend is named **General** until the user renames it, and it is renamed
  the same way as any other friend: Customize, in the Friends widget.
- Its conversations are the ones under the chats root. A folder friend owns
  exactly its own path; this one owns everything beneath its root, because its
  conversations each live in a directory of their own.
- Its memory is its own. The chats root is a project scope like any other, so
  what is settled in All Chats is remembered by All Chats and is not carried
  into any folder. The only memory every project shares is the global one —
  about the user, not about the work.
- Starting a conversation there creates a dated chat directory, exactly as the
  sidebar's *All Chats* does, so the two are the same thing.
- It has a rules file (`AGENTS.md`) and a memory file (`MEMORY.md`) at the chats
  root, edited in the Studio like any folder's. OpenCode finds the rules by walking
  up from each dated chat directory, so they reach every General chat and nothing
  outside the chats root. `ai-team/` under the root carries its own `AGENTS.md` that
  says General's rules do not apply to team runs. It has no guardrail file of its
  own: the Studio hides the guardrail studio for it.
- When the user gives it a name, the sidebar's *All Chats* heading says that
  name, so the area reads as theirs rather than as a system bucket.

## While a friend works

The folder's icon in the sidebar moves while any conversation in that folder is
working, and the friend's face on the Home card moves with it. Both read the
shared live status index, so they are the same fact shown twice. The motion
stops for anyone who has asked for reduced motion.

Brain-only saves preserve existing provider policies and granular permission rules. Capability controls replace only the categories explicitly changed. Conversation continuation re-reads the actual session and requires the exact folder and its configured primary agent; a nested folder remains a separate Friend. Configured primary agents, including manager, take precedence over the generic Operator fallback.

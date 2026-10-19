# Friends (1-to-1 Folder = Friend)

Friends is the `friends` widget on Home and the unified identity across Open Carter's
folders: each folder is a Friend with built-in Operator capabilities, its own
personality (`AGENTS.md`), shared folder memory (`MEMORY.md`), and folder-level
guardrails (`opencode.json`).

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
  - Folder Specialists & background **Team Work** (`HomeFriendsWork`).
- Customize (`HomeFriendCustomize.tsx`): edits Friend name, role/specialty, body
  shape, and theme color, persisted under `open-carter:friends:v1:<runtime>` and
  synced with the left sidebar folder header.

Brain-only saves preserve existing provider policies and granular permission rules. Capability controls replace only the categories explicitly changed. Conversation continuation re-reads the actual session and requires the exact folder and its configured primary agent; a nested folder remains a separate Friend. Configured primary agents, including manager, take precedence over the generic Operator fallback.

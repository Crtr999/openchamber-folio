# Friends

Friends is the `friends` widget on Home: a local Electron view over existing
project-scoped OpenCode agents. It does not register new agents, copy
instructions, connect providers, or change project policies. Names and avatars
are a presentation preference shared by an agent ID on one runtime. Actual
roles, prompts, tools and models remain in the existing agent editor and project
configuration.

## Surface

`HomeFriends.tsx` is the widget content. It takes part in Home's saved widget
order and full/half widths like every other widget (`home-widget-layout.ts`). A
fresh layout leads with Friends at full width; a saved layout without it gains
it at the end. There is no Friends dialog or other entry point.

- Header: title, one compact folder selector (remembered per runtime under
  `open-carter:friends-folder:v1`) and an icon-only refresh. Returning to the
  window re-reads the folder's agents, so refresh is rarely needed.
- Cards (`HomeFriendCards`): avatar, friend name, the agent's display name as
  the role, and a status line. The status line reads the friend's saved
  conversation link: live session status (working/retrying), otherwise the
  session's last update, otherwise the agent description. An unconfirmed
  creation marker shows as such.
- Clicking a card continues that friend's conversation and opens it through
  `setCurrentSession`, so it replaces the focused tab like other Home
  navigation. The card's new-chat button and its menu's New conversation start
  another one. Specialists (subagents) cannot be chatted with directly; their
  card opens Details.
- Card menu: Customize, Details, New conversation. Actions show on hover/focus
  and stay visible on touch.
- Details (`HomeFriendDetails.tsx`) is a right-side panel: description,
  continue/new/customize/agent settings, the folder team's work
  (`HomeFriendsWork`) and the collapsible rules inspector.
- Customize (`HomeFriendCustomize.tsx`): large preview, name, body picker grid,
  color swatches, Cancel/Save. A failed or conflicting save keeps the dialog and
  the draft and says why.

Panels close on Escape (Base UI dialogs) and grow from the card through
`morphFrom` in `lib/motion.ts`; motion and the card/status animations are off
under reduced motion.

## Avatars

`HomeFriendAvatar.tsx` draws one of `FRIEND_BODIES` (rounded inline SVG bodies
with two eye marks) in one of `FRIEND_COLORS`. Colors are theme roles
(`--primary-base`, `--syntax-*`, `--status-success`) resolved by
`friendColorVariable`, never fixed values. Uncustomized agents get a
deterministic default from the agent ID (`defaultFriendAppearance`); Build keeps
its success identity color and other defaults avoid it. Body and color ids are
persisted: append new ones, never rename or remove them. `index.css` clears
rect/circle fills inside buttons, so the avatar CSS restores them.

## Stored presentation

Saved presentation lives under `open-carter:friends:v1:<runtime>` (the key name
predates the record version). The record is `{ version: 2, revision, friends:
[{ agent, name?, body?, color? }] }`. A version 1 record (`aliases` of names) is
migrated on read: names, their first-wins order and the revision carry over, and
nothing is written until the next save, which writes version 2. Reads validate
strictly; unknown bodies/colors, duplicate agents or unknown versions are an
error, never an empty successful reset, and the stored value is left untouched.
Saves are synchronous with a revision check: a stale revision throws
`FriendRevisionConflict` before writing, and a failed write leaves the previous
record in place.

## Scope and conversations

The selected folder scopes catalog/config reads, the rule inspector, team work,
and conversation links. Links (`open-carter:friend-chat:v1`) are keyed by
runtime, directory and agent. Opening one fetches the real session and checks
directory, agent and archive status. Starting a conversation re-reads the agent
catalog, honors the folder model and variant defaults, and uses the normal
scoped OpenCode session API. A saved creating marker blocks blind retry after
ambiguous session creation. Only a deliberate New conversation action starts
another conversation. Conversations and existing project memory stay in their
existing stores; this module creates no shared memory pool.

## Team work

HomeFriendsWork uses the authoritative local team coordinator. Drafts reuse the
runtime/project-scoped team draft store. Reads are serialized and invalidated by
mutations; old folder or runtime completions cannot replace the current view.
It shows existing task history, observed child chats, artifacts and review results.
Models come from the folder's reviewed team policy, not the ordinary chat picker.
Queued work uses the manager and approved specialists, normal approvals and all
existing host/model guards. Only explicit queue submissions create assignments.

## Runtimes

Outside trusted local Electron the widget shows the desktop-only note and makes
no reads. The native team bridge continues to reject remote frames. The Friends
UI does not add listeners, routes, credentials or external services. Ordinary
chat and agent settings are unchanged on web, remote Electron, VS Code, hosted
mobile and Capacitor.

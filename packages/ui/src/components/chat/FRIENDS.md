# Friends

HomeFriends is a local Electron view over existing project-scoped OpenCode
agents. It does not register new agents, copy instructions, connect providers,
or change project policies. Names are a presentation preference shared by an
agent ID on one runtime. Actual roles, prompts, tools and models remain in the
existing agent editor and project configuration.

The selected folder scopes catalog/config reads, the rule inspector, team work,
and conversation links. Links are keyed by runtime, directory and agent. Opening
one fetches the real session and checks directory, agent and archive status.
Starting a conversation re-reads the agent catalog, honors the folder model and
variant defaults, and uses the normal scoped OpenCode session API. A saved
creating marker blocks blind retry after ambiguous session creation. Only a
separate deliberate New conversation action starts another conversation.

Names are stored under open-carter:friends:v1. They are validated on read and
saved synchronously with a revision check. Invalid or unavailable storage is an
error, never an empty successful reset. Conversations and existing project memory
stay in their existing stores; this module creates no shared memory pool.

HomeFriendsWork uses the authoritative local team coordinator. Drafts reuse the
runtime/project-scoped team draft store. Reads are serialized and invalidated by
mutations; old folder or runtime completions cannot replace the current view.
It shows existing task history, observed child chats, artifacts and review results.
Models come from the folder's reviewed team policy, not the ordinary chat picker.
Queued work uses the manager and approved specialists, normal approvals and all
existing host/model guards. Only explicit queue submissions create assignments.

The Home entry is hidden outside trusted local Electron. The native team bridge
continues to reject remote frames. The Friends UI does not add listeners, routes,
credentials or external services. Ordinary chat and agent settings are unchanged
on web, remote Electron, VS Code, hosted mobile and Capacitor.

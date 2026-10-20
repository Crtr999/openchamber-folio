# Session memory capture

What a folder friend learns without being asked.

A friend is a folder. Every conversation in that folder is the same
relationship, and what the earlier ones worked out belongs to the later ones.
Three pieces already carry that:

| Piece | What it owns |
| --- | --- |
| `agent-memory` | the store: what has been remembered, per project and per user |
| `openchamber_memory` (the tool) | the agent saving something by its own initiative |
| `session-knowledge` | telling every session in the project the titles of what is stored |

What was missing is the part nobody does: an agent only remembers what it
noticed at the time, and the user did not ask to be reminded. This module
closes that gap. When a conversation in a folder ends, the turns since the
last capture are read, distilled by a small model, and written into the
folder's project memory. The next conversation in that folder is told about
them by `session-knowledge` without anyone doing anything.

## When it runs

On a `session.idle` event, after a quiet window (20 seconds), and only for
sessions that are not a child of another session. A cancelled turn is skipped:
it never finished, so it says nothing about what the project should remember.

A session is read at most once per turn. The runtime keeps a cursor — the id
of the last message it distilled — and only the turns after that cursor are
considered. A long conversation is therefore captured turn by turn rather than
re-summarised from the top every time, and a cursor that no longer appears
(after a compaction) falls back to capturing the window again; the store
collapses the restatement.

## What it writes

Only the project the conversation ran in. The scope comes from the session's
directory, never from the model. A worktree resolves to the project it belongs
to, so a worktree's memory is the project's memory.

The store's own rules apply to everything written: a restatement replaces the
entry it restates, titles are capped at 60 characters, bodies at 2,000, and the
project store holds at most 200 entries. A store that is full says so, and
this runtime stops asking for that project rather than retrying.

The chats root — the app's own directory for conversations that belong to no
folder — is a project scope like any other, so All Chats keeps a memory of its
own and shares none of it with any folder. The only store every project reads
is the global one, which the agent alone writes.

## What it will not do

- **It never reads a folder through another provider.** The conversation's own
  provider is the only one allowed to distil it. A folder bound to one provider
  — a ZDR folder is the case that matters — must not be summarised through a
  different one, which is what a default model would do when the bound
  provider has no small model. If the resolved model is in another provider,
  nothing is captured.
- **It never writes global memory.** Global memory shapes every session in
  every project; only the agent may write there.
- **It never writes to the team runtime's home.** The `ai-team` directory
  under the chats root holds the folder managers' own assignments; those are
  machine conversations, not the user's.
- **It never touches the user's own files.** `AGENTS.md` and `MEMORY.md` are
  the user's; the capture writes to the store, which is the agent's.

## Failure behaviour

Nothing here may fail a turn. The capture runs after the conversation ended,
on a timer, and every failure is swallowed with a log line: a model that
refuses, a store that cannot be read, a session that was deleted mid-read. The
worst case is that a folder does not learn something, which is the state the
app was in before this existed.

## Turning it off

Two switches, and they are not the same thing:

- `OPENCHAMBER_MEMORY_ENABLE=0` — the whole feature is absent: no tool, no
  routes, no session index, no panel, no capture.
- `folderMemoryAutoCapture` (settings, on by default) — the capture stops.
  The agent's own memory keeps working.

## What is not proven

The capture is driven by the same small model the recap uses, and it inherits
that service's provider and credential rules. It has not been run against a
live OpenCode in this repository's test suite: the tests drive the runtime
with an injected client and an injected model, which proves the wiring and the
refusals, not the quality of what a real model distils. A capture that stores
the wrong thing is corrected the way any memory is corrected — the panel, or
the agent saving the same memory again.

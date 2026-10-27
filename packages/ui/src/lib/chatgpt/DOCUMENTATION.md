# ChatGPT conversation continuity

The website view keeps ChatGPT-owned history and connections on the official
website. `native.ts` selects the separate OpenAI-backed Open Carter project.
Logging into either does not copy ChatGPT Health records or app authorizations.

## One-way export import

The explicit Import chats action in the desktop website view accepts a ChatGPT
export ZIP or conversations.json, up to 100 MiB. A worker parses it outside the
renderer thread. Only conversations.json is extracted, with an uncompressed
size ceiling. The active parent chain is retained, in order. Unknown schemas,
missing active nodes, broken parents, cycles and transcripts above one million
characters are refused rather than guessed or truncated. An unreadable
conversation does not remove another valid conversation. Search displays at most
50 matches; the user narrows by title. Closing releases the worker and in-memory
export. No background account scraping or credential access runs.

Selecting a conversation creates a real OpenCode session on the existing OpenAI
connection in the ChatGPT project. The SDK retains the original transcript in its durable synthetic inbox with
resume=false. It is admitted to the timeline and model context on the next
deliberate user turn. It does not run the model or
execute historical tools. The queued context survives reconnecting to OpenCode;
the next deliberate user message continues with the normal native tool catalog.
This is a retained text copy, not replicated original message identities or
ChatGPT account memory. Attachment bodies and connected app data are not copied;
rows with omitted attachments say Text only. The import notice explains this
before selection. A failed context save remains retryable against the same
session/message within the dialog. It is never reported as successful. Closing
after failure can leave the created empty session; it is not deleted implicitly.
Repeated deliberate imports after closing create independent copies.

Runtime identity is captured for each import. A switch prevents subsequent
admission or navigation against another runtime. The session write owns its
original scope. ZDR refuses this OpenAI-bound import. No imported text leaves the
active server for a model until the user sends a message.

## Runtime behavior

- Electron local: file import is available inside the retained website view.
- Web: no website guest or import entry point.
- VS Code: no website guest or import entry point.
- Hosted mobile: no website guest or import entry point.
- Capacitor mobile: no website guest or import entry point. Chats already
  retained on its connected server are ordinary shared sessions.

Apple Health requires a separately authorized iPhone HealthKit integration.
WHOOP and Outlook require their own authorized provider connections. None of
these is established by importing a ChatGPT transcript. Medical records absent
from the export require their original files or a separate records connection.

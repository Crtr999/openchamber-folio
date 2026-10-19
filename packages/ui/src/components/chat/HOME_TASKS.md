# Home task widgets

`HomePersonalPanels.tsx` defaults to AI Tasks. Only a deliberate selector click
writes `open-carter:home-task-view:v1`. A saved Daily To-Do choice remains valid.
Daily To-Do reads its board only while selected. Habits and Calendar keep their
own reads because their widgets remain visible.

`HomeAiTasks.tsx` reads local coordinator status, the Notion board and the model
catalog separately. Model discovery cannot hold the board's first paint. Each
loader has one in-flight request, and a mutation invalidates older board results.
A refresh failure keeps the last successful board and shows the error. No board
snapshot is persisted by these components. Setup stays available after a board
failure, and a 15-second notice explains a slow read without clearing drafts.

Assignment writes always include an approved concrete model. Folder changes
keep the card's saved model when the target folder approves it, then use that
folder's approved remembered choice or its declared default. Folderless handoff
uses the All Chats catalog, never the ordinary chat composer's selection.
A saved explicit model missing from its folder's catalog stays visible as
unavailable rather than appearing to use the folder default. Handoff fails
before moving the card or saving notes, keeping drafts intact. Legacy assignments
without a model receive a concrete model before handoff. The host must validate
model approval independently.

The card trash control opens a confirmation that names the card and explains
Notion trash recovery. It calls `deleteAiTask` only after confirmation. A running
card has no enabled trash action. The native host must enforce membership and
active-run refusal independently. Successful deletion removes the card locally
before refreshing; a failed refresh cannot restore an older in-flight snapshot.
Existing chats remain intact. Failed deletion keeps the card and confirmation
open with the host's error.

Notes accept page links plus an assignment name, or a page title with its
dashboard and assignment. The hint treats those references as context, not
authorization. Reference resolution belongs to the native intake adapter.
Failed note writes preserve the draft and show their error.

Local Electron is supported. Web, remote desktop, VS Code, hosted mobile and
Capacitor retain the existing unsupported state. Loading skeletons use a
one-shot opacity reveal, never an indefinite shimmer. Card titles wrap, and
compact card actions move beneath the brief below 420px of widget width.
Reduced motion disables these reveals.

`HomeChatGPTTasks.tsx` is not one of these widgets and must not be folded into
them. It renders Carter's own ChatGPT automations as a read-only card above the
widget layout, and an external provider row never becomes a local schedule. Its
contract lives with `packages/electron/chatgpt-automations.mjs` and
[the account integration findings](../views/account-integration-findings.md).

Focused regression tests are `HomeAiTasks.test.tsx` and
`HomePersonalPanels.test.tsx`. Their bridge fixtures exercise UI behavior, not
live Notion, model readiness, native authorization or installed-app rendering.

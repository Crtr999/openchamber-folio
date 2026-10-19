# Personal creation and references

## Ownership and supported runtimes

`model.ts` owns the bounded version-1 `.ocwork` JSON format. `exports.ts` owns
local Office, SVG, PNG and CSV export. `pdf.ts` produces image-based PDFs locally.
`references.ts` owns saved-site validation and selected reference snapshots.
`components/personal/` owns the editors and the composer dialog. FilesView mounts
the native editor through its existing canvas save, autosave, conflict and
fullscreen machinery. Do not add an independent writer to that editor.

| Runtime | Behavior |
| --- | --- |
| Local Electron | Editors, export, project copies, references and local meeting selection. |
| Remote Electron | Editors, export and active-runtime project/chat references. No local meeting access. |
| Web | Editors and browser downloads, with project storage through the active runtime. No native meetings. |
| VS Code | The existing files-only composer attachment control is unchanged. The shared mention picker can attach project/chat/site context. Native creation menu is not exposed. |
| Hosted mobile | Creation opens from the attachment sheet. Files use the connected host. Downloads depend on the browser. No native meetings. |
| Capacitor mobile | Same creation sheet and connected-host file storage. Downloads depend on WebView support and are not device-verified. No native meetings. |

These changes add no network listener, credential entry point, external fetch, or
automatic egress. Sources are attached to an unsent draft. They reach its chosen
provider only through the normal send path. Native meeting authorization stays
at its existing IPC boundary. Selected meeting references deliberately include
notes, summary and transcript, disclosed in the reference dialog. No transcript
content is used to rank the picker. The list is matched on title and date only.

## Editing and durability

The composer dialog keeps an unsaved local draft and asks before discarding an
edited artifact. Save a copy writes a new UUID-suffixed file under the captured
project's `artifacts/` directory with overwrite disabled. A failed create or
upload preserves the draft. A successful copy can be opened in FilesView for
normal save/autosave. A detached dialog cannot publish async results into a new
runtime. Chat attachment work remains scoped to input-store's draft identity.

Exports also save new files in `artifacts/` and open them inside the app when the
runtime supports uploads; otherwise they use browser downloads. Neither path
overwrites existing files. Office input previews show bounded extracted text
and embedded images, not original layouts or live calculation.

Templates reuse saved `.ocwork` content into a new draft. They never write to
the original. The `template` flag records intent; any saved artifact can be reused.
Import accepts `.ocwork`, Markdown/text and bounded CSV/TSV, not arbitrary Office
packages. Existing Office inputs remain supported by the chat attachment
extractor and model-side file skills. No macros or arbitrary HTML are executed.

## Calculation and export limits

The spreadsheet calculator parses expressions, never evaluates JavaScript.
It supports current-sheet A1 references, ranges, arithmetic, comparisons and
SUM, AVERAGE, MIN, MAX, COUNT and lazy IF. It bounds expression length,
dependency depth, references and evaluation work. Unsupported formulas show an
error and export as inert text rather than an executable XLSX formula. CSV
exports calculated values and neutralizes formula injection. This is not a full
Excel engine, cross-sheet formula engine, chart editor or formatting engine.

Office export is intentionally basic. DOCX preserves paragraphs and heading
sizes, not all Markdown formatting. PPTX preserves slide text and speaker notes,
not animations or arbitrary designs. XLSX preserves cells and supported formulas.
PDF uses local canvas rendering and JPEG pages so browser fonts can render
Unicode without sending content elsewhere. It is not searchable or tagged, and
is not an exact Office-layout converter. Exports leave the editable source intact.
The UI states these limits. Advanced file workflows use the selected model's
actual installed skills and tools, not a claimed consumer-app connector.

## References and connected workflows

Saved sites are scoped by active runtime in local browser storage. Entries
contain an HTTP(S) URL without credentials and user notes. Attaching is explicitly
not a live snapshot or edit permission. A future turn must fetch the URL with its
available tools to learn current page content. A damaged store is an error, not
permission to replace it with an empty list. Storage changes notify other pickers.

The picker combines saved sites, configured projects, active native chats and,
on trusted local desktop, meeting titles. Website-owned ChatGPT/Claude/Gemini
account history is not imported. A selected native chat snapshot contains at most
20 messages, 6000 characters per message, and text only. The attachment states
the omissions. Reference attachments are bounded to 200000 characters and mark
truncation. They are source data, not instructions or write authorization.

PDF tools and Notion still prepare visible composer requests. They do not execute
those workflows. General Notion access is separate from the Home board connection.

Record a skill now opens `TeachingDialog`, not the composer. On local desktop it
uses `desktop_personal_teaching` and `server/lib/personal-teaching.js` to start/stop
CarterBot capture and review recordings. The endpoint and bearer come from the
global OpenCode CarterBot configuration. Credentials stay in main; an ephemeral
cookie-isolated, sandboxed guest renders the live screen and Chromium video
player. No token-bearing URLs or Mac screen capture are used. Other runtimes
show an unsupported message. Enterprise mode blocks access, except stopping
already-owned capture. Closing, renderer loss, runtime switching and normal quit
attempt capture cleanup; connection failures remain visible rather than claiming
capture stopped. A force kill or network loss cannot guarantee remote cleanup.
`TeachingSkillPanel` completes the recording workflow through the separate
`desktop_teaching_skill` gate. `server/lib/teaching-skills.js` owns drafting,
validation, persistence, installation and test dispatch. Generate explicitly
sends key frames, recorded browser events and the task description to the chosen
image-capable OpenCode model. No provider credentials are copied or fallback
models selected. A temporary compiler session denies every tool and is aborted
and deleted after generation. Closing cancels generation; its deadline is three
minutes. Local drafts live under Electron userData/private-teaching, and the
editor also preserves unsaved text in local browser storage per recording.

Install is a separate approval. It validates SKILL.md structure, namespaces the
name by recording and content revision, refuses different existing content, and verifies CarterBot
readback before reporting installation. A connection failure can mean the remote
write succeeded; retrying identical content reconciles without overwriting it.
Skills are installed on CarterBot, discoverable with skill_list/skill_read by
future bots in any project. Editing clears the installed revision and requires
installing again. Each changed revision receives its own non-overwriting name.

Run test creates and prompts a real native chat in the captured project with the
chosen model and ask-by-default tool permissions. It opens that chat so the user
can approve tools and inspect results. Dispatch is never labelled a passed test.
This is agent execution of the reviewed skill, not blind pixel/event replay.
Credentials and consequential actions still require the standard handoffs and
approvals. All skill operations are blocked in enterprise mode and unavailable
outside the trusted local desktop main frame. No HTTP skill route is exposed.

Sketches use a dedicated canvas and floating icon palette. Composer creation
hides generic Office controls, prompts and template fields. Attach still creates
a PNG plus editable source in the unsent draft. The file editor retains exports
in its overflow menu. The canvas favors intent over precision: a click leaves a
visible ink dot, pen strokes are smoothed, the eraser removes anything near the
pointer and a drag pass becomes one undo step, and an empty text click focuses
the label field instead of doing nothing. Drawing focuses the canvas so the
undo shortcut works immediately, the Sketch row in the creation menus shows a
hand-drawn scribble mark in teal, and an untouched new draft closes without a
discard prompt.
Saved-site editing is collapsed until Add site or Edit.

## Validation

`workspace.test.ts` covers schema round-trips and rejection, calculator behavior
and limits, safe Office/CSV/SVG exports and every shipped translation. Browser
checks additionally need actual sketch pointers, focus, menu navigation, canvas
save/fullscreen transitions and downloads. Static tests do not prove Office-app
interoperability, account connectivity, teaching execution or device downloads.

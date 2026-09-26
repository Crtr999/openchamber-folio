# Folio integration

This personal Mac fork carries Folio's complete implementation into OpenChamber. It is not the limited extension prototype. Upstream OpenChamber remains the owner of sessions, models, projects, tools, terminals and Git workflows.

## Runtime decisions

- Electron on macOS: native Folio library and Mac capabilities, with a page tree in the main OpenChamber sidebar and an integrated editor.
- Electron on Windows/Linux: Folio is explicitly unsupported; other OpenChamber features keep their existing behavior.
- Web: Folio's local Mac library is not exposed through the HTTP server.
- VS Code: no Folio native capability; existing behavior remains.
- Hosted mobile: no Folio native capability; existing behavior remains.
- Capacitor mobile: no Folio native capability; existing behavior remains.

The native helper owns SQLite, history, attachments, recordings, keys, local file access and Apple permissions. A narrow local-page-gated IPC bridge handles typed operations. No remote page or remote OpenChamber server receives the local library. A separate Folio-OpenChamber library avoids competing writers with the original application. No migration is required because the owner explicitly said existing content does not matter.

## Required parity

- Pages: hierarchy, icons, favorites, tags, Trash/restore, duplication, full-text search, history, autosave and daily backup.
- Editing: continuous paragraphs; headings 1–4; toggle headings 1–4; bullets, numbering, tasks, toggles, quote, callout, code, equation, divider, page links and attachments; block movement; selection formatting; bold, italic, underline, strike, inline code, links, nine text colors and nine highlight colors; font size and highlight strength.
- Databases: library template, blank table, typed properties and cells, row/column management, CSV import/export, Table/Board/Chart, grouping and count-by charts.
- Voice: offline Bella using the existing Lilt model, installed system voices, speed, pause/resume/stop, on-device dictation with insertion.
- Meetings: explicit microphone/system-audio recording, meters, segmented local files, recover/import, resumable transcription, cancel, timestamps, local chat summaries.
- Calendar: local Apple Calendar connection, upcoming meetings, join links, scheduled prompts and prepare-recording flow.
- Local documents: PDF/images/Word/RTF/text import, OCR, forced OCR, attachments and cancellation.
- Exports: MD/TXT/PDF, CSV, complete note-library JSON and assets.
- AI: Folio BYOK chat and transcription, context scopes and privacy exclusions, source inspection, stop, save/append/review replacement; send page context into OpenChamber.

## Validation

The first Apple Silicon trial app has been packaged and launched. Native bridge smoke checks cover library creation, persistence, revision conflict rejection, export, Trash/restore, and clean shutdown. Automated tests cover rich text with Unicode/legacy formatting, save serialization, failed-save draft preservation, and desktop startup gating. The full workspace type check and lint pass (one existing upstream lint warning remains). Table, Board, Chart, sidebar navigation, and the native settings window were exercised through the desktop UI.

Live microphone/system-audio capture, transcription provider calls, AI responses, and calendar authorization still require real test inputs and permissions. They retain Folio's original implementations but have not been verified end to end in this fork. Meeting, assistant, calendar, history, and settings tools currently open native Folio utility windows alongside the embedded editor. Dictation appends a block to the selected page. This is a trial integration, not a claim that every interaction is already identical to standalone Folio.

## Building and running

Use Bun 1.4.2, Node 22+, and a full Xcode installation with its license accepted. Apple Command Line Tools alone cannot compile Folio's SwiftUI macros. Run `bun install`, then `bun run --cwd packages/electron package -- --mac --arm64`. The package task builds the native helper and web UI, stages OpenCode, bundles Electron, and rebuilds terminal dependencies. For a local unsigned trial, the builder can use ad-hoc signing; public distribution requires your own signing and notarization setup.

The supplied trial bundle is named **OpenChamber Folio.app**, has a distinct application identifier, and uses `~/Library/Application Support/Folio-OpenChamber` for notebook data. It uses the existing OpenChamber project/server configuration. Personal-fork updates must be built from this repository; upstream auto-update is disabled so it cannot remove Folio.

The trial contains the native helper successfully compiled earlier on this Mac. A subsequent Xcode update requires license acceptance before recompiling it; no license was accepted automatically. Voice models are discovered from the original Lilt/Folio locations and are not duplicated in the application bundle. Configure your own provider keys through Folio settings.

## Source ownership

- `native/Folio`: original Folio core, Mac services, UI utilities, and JSON-line bridge.
- `packages/ui/src/components/folio` and `packages/ui/src/lib/folio`: embedded notebook, databases, formatting, typed protocol, and autosave state.
- `packages/electron/folio-engine.mjs`: one local native process, validated requests/responses, and shutdown.
- The existing runtime API carries the optional local Mac capability; no notebook HTTP endpoint is added.

A ready local notebook can release the startup overlay while OpenCode connects. This still requires a valid desktop boot outcome and does not bypass chooser/recovery or web authentication.

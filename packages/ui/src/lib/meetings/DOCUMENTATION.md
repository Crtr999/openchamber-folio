# Local meeting capture

`contract.ts` parses the native IPC results. Meeting records and transcription
are owned by the web meeting service, native authorization and lifecycle events
by Electron. Components do not send meeting content through ordinary chat.

`capture.ts` has one renderer-wide owner. Navigation and workspace dismissal
leave capture running, with controls mounted by `MainLayout`. Consent and model
readiness precede OS requests. Native start grants system capture before
`getDisplayMedia`; microphone-only is a separate explicit choice, never a
fallback after denied system capture. Screen sharing is required for loopback
audio. The video track stays alive because stopping it can end audio, but the
renderer never reads, saves or sends its frames.
Native rechecks the display grant's expiry after source discovery. Pause revokes
an unused or pending grant; resume does not revive it.

The worklet mixes channels to mono and averages into 16 kHz PCM off the renderer
thread. Each source has a 10-second bounded buffer and is cut at the first
half-second pause once it holds three seconds, so text arrives phrase by phrase.
Chunks with no sound are never sent. Up to eight chunks, including the one being
transcribed, may be pending. Transcription is serial with a 120-second deadline.
Backpressure fails visibly rather than dropping chunks or growing memory. A
device-list change such as headphones connecting is not a failure; an ended
track or processor error is. Failures carry a short content-free reason beside
the generic message. Pause and normal stop flush the worklet tail and drain chunks
before the native transition. Stop releases devices before waiting for that
drain. Errors, device changes and native interruption clear unsent buffers and
stop devices without replay. Permission acquisition has a 60-second deadline;
late-resolved streams stop their tracks.
Audio-context startup also has a 15-second resume deadline and rechecks capture
ownership before publishing recording. An interruption during resume cannot
restore recording after devices have closed.
Start failures, starting cancellation and capture errors immediately invoke the
native interrupt operation, which bypasses busy controls and revokes pending
start/chunk generations. This happens before waiting for the renderer chunk
drain, including when a timed-out native start has not returned its result.
The returned interrupted record refreshes only its current capture generation.
Starting can be canceled from the global
Stop control. No raw audio is persisted or sent to a hosted fallback.

Home's compact Start meeting action sits right-aligned before the widgets. With
the one-time recording acknowledgement remembered on this device
(`REMEMBER_CONSENT`) and the model ready it creates a meeting with a localized
timestamp title and starts recording in one click, opening the live transcript.
Otherwise it opens the title editor, where Create meeting saves a draft and
recording needs the acknowledgement and a separate Start click. It clears only
the selected view, never saved records or note drafts. The last-used capture
mode (system and microphone, or microphone only) is remembered for one-click
starts. Calendar event Record buttons start the same way. The transcript tab
types new phrases in and follows the newest line while capture is live.
Missing-model controls open the existing Voice settings for local Parakeet setup.
Reopening the workspace refreshes readiness without downloading anything.

`MeetingWorkspace` retains in-memory note drafts across local meeting selection
and dialog dismissal. Explicit Save writes only that meeting. Runtime switching
clears local drafts and selection. Authoritative read failure keeps the prior
list; damaged-record warnings mark partial results, including an all-damaged
list. Source labels are localized from source codes, never presented as speakers.
Stopped and interrupted recordings are closed; another recording needs a new
meeting.

Summary discovery runs only after a click on a closed meeting. No-model prepare
lists configured provider choices without uploading content. Choosing a model
and reviewing it obtains a native approval token. A separate consent checkbox
discloses transcript-only data, the provider/model and unknown cost/subscription
coverage. Only the next explicit Generate Summary click sends through the
sanctioned one-shot small-model operation. Notes, title, calendar and audio are
excluded. Native/backend enforce enterprise refusal and authoritative transcript
revision, expiry and closed-state guards. No model fallback or chat creation runs.
Unavailable models and failures remain explicit; no summary is fabricated.

## Runtimes and validation

- Trusted local Electron main application only supports this feature.
- Remote Electron, web, VS Code, hosted mobile and Capacitor, including iPhone,
  are unsupported. Native authorization is independent of renderer visibility.

On macOS 14.2+, Electron requires `NSAudioCaptureUsageDescription` in the
application's Info.plist. The package also declares `NSMicrophoneUsageDescription`.
Electron 39 and later use CoreAudio Tap by default; this feature adds no legacy
Chromium feature-flag fallback. In terminal- or IDE-launched HMR, the parent
terminal or IDE must itself contain the audio-capture plist key. The package
configuration cannot supply that parent's permission description.
See [Electron's capture caveat](https://www.electronjs.org/docs/latest/api/desktop-capturer#macos-versions-142-or-higher).

A missing audio-capture description can produce a dead audio stream without an
error. Readiness, an acquired track or the recording state do not prove that
system sound was captured. Silent meters are not a success check. Packaged
system capture remains a candidate, with Teams, Zoom and headphone compatibility
untested. iPhone call recording is unsupported; calendar and Notion reminders
are absent.

The focused tests use synthetic PCM and permission promises, not real devices,
calendar events or confidential content. Static checks and these tests do not
prove OS permission dialogs, loopback availability, local model latency or
hardware levels. Meter updates are bounded to two renders per second; buffer
sizes and operation deadlines are correctness limits, not measured performance
claims.

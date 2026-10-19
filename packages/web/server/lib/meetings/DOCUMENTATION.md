# Private meetings service

`service.js` exports `createMeetingService({directory, modelId?})`. Electron
imports it directly. There are no meeting HTTP routes, shared runtime APIs,
listeners or remote-instance calls. Web, VS Code and mobile do not instantiate
this service. Native glue owns trusted local-frame checks and the capture consent
flow. Only one service may own a directory in a process; native must also keep
its existing single-instance application ownership.

Creation synchronously registers the root with `private-paths.js` before any
asynchronous work. Generic HTTP filesystem routes and searches must deny this
root and its aliases even with outside-workspace access enabled. Registration
lasts for the process, including after `dispose()`. The filesystem route owner
owns these enforcement checks; they are separate from native IPC authorization.

## Contract

All methods return promises except the warning snapshot:

- `list()` returns meeting records, newest first. `create({title?,calendarEventId?})` creates a
  draft; `get(id)` reads one record. `updateNotes(id, notes)` writes plain notes.
- `getWarnings()` synchronously returns copies of `{id,code,message}` warnings
  from the last completed list. Native must snapshot these immediately after
  awaiting list and attach them as `warnings` to its IPC list response, before
  other awaited work. The UI must show a partial-results notice, including when
  all records are damaged. A directory safety or filesystem failure still rejects
  list rather than yielding partial success.
- `start(id)`, `pause(id)`, `resume(id)` and `stop(id)` return the updated record.
  Only one meeting can record or pause at a time. Closed states are `stopped`
  and `interrupted`. `start(id)` also reopens a closed meeting (for example after
  a quit, sleep or crash): it returns to `recording`, keeps all saved text and
  notes, and new chunks must start after the last saved text of the same source.
- `transcribeChunk(id, {source, startMs, endMs, pcm16k})` returns the updated
  record. `source` is `microphone` or `system`. `pcm16k` is a normalized number
  array or Float32Array containing mono 16 kHz samples, at most 90 seconds.
  Timestamps are milliseconds relative to the meeting start and must match the
  sample count within one millisecond. Same-source transcript segments cannot
  overlap. Different sources may overlap. This is source labeling, not speaker
  identification.
- `interrupt({id?, reason})` cancels the matching chunk and saves an interrupted
  record. Reasons are `sleep`, `quit`, `navigation`, `renderer-gone` and
  `capture-error`; omitting
  id targets the active meeting. It returns null when there is no active meeting.
- `readiness()` returns `{available, modelId, reasonCode?}`. Missing model files
  give `models_missing`. This does not load or download a model.
- `dispose()` interrupts capture and releases directory ownership.
- `notes` and `chunk` alias `updateNotes` and `transcribeChunk`.

A record contains `version:1`, UUID `id`, `title`, ISO `createdAt` and
`updatedAt`, `status`, nullable `interruptionReason`, `notes`, `segments` and
`summary`, plus an optional local `calendarEventId` link. Calendar links are not
summary input. Segment fields are `{source, label, startMs, endMs, text, createdAt}`.
Labels are exactly `Microphone` and `System audio`. States are `draft`,
`recording`, `paused`, `stopped` and `interrupted`.

Errors reject with a safe `code`, including `busy`, `invalid_state`,
`invalid_audio`, `models_missing`, `timeout`, `interrupted`, `unsafe_storage`,
`invalid_record`, `not_found` and `disposed`. Native should map unexpected
filesystem failures to a generic error instead of exposing paths to the UI.
List failure is not an authoritative empty list. A corrupt record is left
untouched and produces an explicit record warning, while unrelated records
remain readable. A file-specific symlink or hard-link failure also warns; an
unsafe storage directory never counts as a skippable record warning.

## Audio lifetime and local inference

The service imports only the existing dictation local catalog, installed-file
check and worker client. It never imports the dictation provider resolver or
settings, requests downloads, accepts endpoints or reads API keys. The default
model is the catalog's English Parakeet model; native may explicitly choose a
catalog STT model independent of dictation settings. Models already downloaded
through dictation setup are reused from the local speech-model directory.

PCM ownership transfers on entry, including invalid and busy requests. The
service zeros caller samples and its PCM16 buffer on every outcome. It accepts
one chunk at a time and rejects extra chunks without queuing them. Silence below
the dictation peak threshold skips inference. One existing dictation worker is
started when recording starts or resumes, so the speech model is already loaded
when the first phrase arrives, and decodes each non-silent chunk once. The
worker holds no audio between chunks. It is terminated, and the service waits
for its process to close, on pause, stop, interruption, dispose, abort, timeout
and any failed decode; the next chunk starts a fresh worker. This removes
worker-owned native audio copies rather than claiming JS zeroing erases native
allocations. Keeping the worker warm replaced one worker per chunk, which paid
a process start and model load for every phrase and made live text impossible;
real model latency has not been benchmarked.

The timeout bounds inference to 120 seconds, including worker setup. Pause and
stop reject with `busy` during a chunk; the capture owner must finish its tail
chunk first. Interruption aborts immediately and waits for cleanup before saving
the interrupted state. Failed chunks do not remove earlier text or notes. The
`capture-error` interruption handles native capture failures or UI deadlines;
unlike stop, it cancels and joins an in-flight chunk before saving partial text.
There is no audio-file path, WAV staging, audio recording or hosted STT fallback.
The native caller must also clear its capture buffers and IPC copies.

## Persistence and recovery

Native supplies a normalized absolute device-local directory outside synced
folders, such as its application-support `private-meetings` directory. The
parent must already exist. Directory components cannot be symbolic links.
The directory uses 0700; JSON records and atomic text-only staging files use
0600. Reads use no-follow file handles and reject nonregular or multiply-linked
files. Writes use exclusive staging, fsync and rename. UUID-only filenames and
strict bounded schemas reject traversal and accidental audio fields. Records
are capped at 8 MiB, notes at 100,000 characters, segments at 10,000.

Directory identity is rechecked around operations. Node's portable filesystem
API has no directory-relative `openat` transaction, so these checks do not
claim protection against a malicious same-user process concurrently replacing
ancestor directories. Permissions protect other users on POSIX systems;
native deployment must enforce appropriate local ACLs on Windows. App-private
storage is not encryption or protection from device backups.

First use recovers saved recording/paused meetings as `interrupted` with
reason `crash`, keeping committed text and notes. Uncommitted audio is lost.
Text staging files from interrupted atomic writes are removed; damaged records
are not erased or silently converted to empty records. Failed writes preserve
the previous record. Shutdown without audio still records interruption.

## Deliberate summary persistence

Records initially contain `summary:{status:'unavailable', reason}`. This service
has no generation, chat insertion or provider access. The native-approved summary
module may call `saveSummary(id, {text, providerID, modelID, transcriptRevision})`
after its own one-time approval and enterprise/provider checks. The hook accepts
only stopped/interrupted meetings and compares the revision inside the serialized
read/write operation. The revision is SHA256 of
`JSON.stringify(segments.map(({source,startMs,endMs,text}) => ({source,startMs,endMs,text})))`,
preserving exact text and key order. Notes, titles, labels and dates are excluded.
Stale results reject with `stale_transcript`; nothing is auto-generated. A saved
summary has `status:'available'`, the supplied fields and ISO `createdAt`.
This hook is private native code, not a renderer-facing shortcut around approval.

`summary.js` owns the sanctioned generation path separately. Its factory
`createMeetingSummaryService()` exposes `prepare({meetingId,status,segments,model?})`
and `generate({meetingId,status,segments,model,approvalToken,approved:true})`.
Native supplies the authoritative saved segments and closed status, not renderer
text. Preparation without a model lists configured small-model choices; sending
requires an explicit model and one-time approval bound to meeting ID, that model
and the exact transcript revision. Approval expires after five minutes and is
consumed before generation, including failures. It sends transcript fields only,
never notes, title, calendar context or audio. It does not change configuration,
use another provider as fallback, or create an ordinary chat session. Enterprise
mode always blocks preparation and generation at the sending boundary. The
approval disclosure reports cost and subscription coverage as unknown rather
than promising a subscription benefit. Native owns provider selection and
approval UI; failure leaves the prior saved summary unchanged.

Native passes a private second argument to `generate`, `{signal, authorize}`.
The summary service rechecks cancellation and native authorization after catalog
lookup, immediately before dispatch. Runtime change, window lifecycle interruption
and quit abort pending native summary requests. The signal also reaches the
one-shot generator to cancel its request and retry waits. Cancellation cannot
recall transcript text already dispatched to an approved provider. Late results
are rejected rather than saved. Disposing the summary service aborts its work and
prevents a pending preparation from recreating an approval.

## Tests

`service.test.js` uses synthetic audio and dummy local model files with an
injected worker client. `modelsDir`, `timeoutMs` and `workerFactory` are private
dependency-injection options for focused tests, never renderer inputs. Tests
need no real model download, microphone, system audio device or confidential
data. Real sherpa inference and native capture require separate native QA.

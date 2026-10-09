# Retained context views

## Meetings

`MeetingWorkspace` is mounted once below the main header. Home's calendar heading
and each event row open its lightweight dialog; opening never starts recording.
The capture owner survives view navigation and dialog dismissal, with global
pause/resume/stop controls. Local title/time lists, editable notes, source-timed
transcripts and deliberate provider-approved summaries do not create chats.
Read [local meeting capture](../../lib/meetings/DOCUMENTATION.md) before changing
its consent, lifecycle, native contract, buffers or summary approval behavior.

## Claude website

`ClaudeWorkspace` opens the complete official `https://claude.ai/` website on
explicit selection, retaining one guest in `persist:open-carter-claude` across
main-page switches. Claude owns sign-in, subscription features and history.
Full Claude focuses the existing full website without navigating or replacing a
draft. Home's Claude chooser explicitly navigates the same guest to the official
root URL. A fresh signed-in conversation is not verified; the user starts it with
Claude's own controls. Back, Forward and Reload are explicit. Navigation events
supply live exact-origin URL/title metadata. Explicit pinning saves only observed
URLs without credentials, queries or fragments and titles locally under
`open-carter.claude.saved-pages.v1`. Saved links reopen in the same guest and can
be removed without deleting website data. They are not account/team-scoped history
or native transcripts; account switching stays in Claude. No verified signed-in
DOM is available, so no automatic conversation capture runs. No messages, cookies, app stores or guessed
conversation routes are read. There is no API/provider connection or automatic
OpenCode export. Runtime changes clear title/request state without clearing login
storage. Only local Electron exposes this view; every other runtime is unsupported.
Main-process attachment and permission rules live in
`packages/electron/website-guest-security.mjs`.

### Native provider feasibility, checked October 8, 2026

Current account-history and external scheduled-task findings, including real
Enterprise compliance APIs and their access requirements, are in
[account-integration-findings.md](./account-integration-findings.md). Local saved
pages are not account history. No external feed runs in the Scheduled sidebar.

Native ChatGPT uses ordinary OpenCode sessions through the OpenAI provider, not
website transcripts or account memory. OpenCode V2's [provider documentation](https://opencode.ai/v2/docs/providers)
does not document a Claude subscription login equivalent. Anthropic's current
[authentication policy](https://code.claude.com/docs/en/legal-and-compliance)
permits end users to sign into an unmodified official Claude Code binary, but
does not permit third-party applications to collect or intermediate Claude.ai
tokens. That separate binary is not an OpenCode provider or a cloud-history
adapter. No native Claude option is added, and API billing is not substituted.

Muse's official [product description](https://introducing.muse.ai/) confirms
cloud-owned memory, background work, goals and artifacts. No supported public
API for those account features was verified. Requests to `https://muse.ai/api`
and `/developers` returned HTTP 401, not usable API documentation. Old video-hosting
API search results and Meta's model API do not establish access to this Muse
account. Its real website remains unchanged rather than claiming a native clone.

## Context panel retention

`ContextPanel` keeps file, diff and walkthrough views mounted to preserve
navigation, expanded sections and editor state. Its `visible` prop combines
the panel's open state with the selected tab. Hiding via CSS alone does not
pause React effects.

File tree ownership and request rules are in `files/DOCUMENTATION.md`.
`DiffView` gates repository discovery, comparisons, per-file reads, viewport
measurement and keyboard navigation on visibility. Hidden refresh hints retain
only dirty paths scoped to runtime and directory; reopening invalidates those
paths and requests fresh status. Completed range diffs remain cached while
pending reservations are cancelled and retried on resume. Hidden tabs never
consume another tab's pending navigation request.

`WalkthroughView` gates discovery and source loading while retaining generated
results and any explicitly started generation job.

## Large text files

The 200,000-character threshold selects an initial code preview, not read-only
permissions. Users can switch large text files into editing through the normal
view controls. Markdown, HTML, JSON and Draw.io retain their own preview-mode
preferences. Binary, image and outside-workspace restrictions still apply.
`fileEditorContent.ts` preserves the complete normalized text in both the loaded
snapshot and draft, and restores the detected line ending on save. Preview
limits must never truncate a writable draft or its dirty-comparison baseline.
Large code previews render the current draft and hash its full content only
while previewing, so same-length edits in the middle invalidate cached output.

## Pull request comparisons

DiffView, mobile Changes and walkthrough share `PullRequestComparisonSelector`
and the selection owned by `usePullRequestComparison`. PR mode reads GitHub's
published patch through `/api/walkthrough/pr-diff`. It includes no local edits
or unpushed commits. `lib/diff/pullRequestDiff.ts` splits the response once;
`useGitComparison` serves file patches from that same snapshot. Snapshot revisions
invalidate the view's patch cache atomically, including edits with unchanged
file names and line counts. Opening a file adds no network request.

PR comparisons retain completed snapshots across panel and mode switches.
`pullRequestSnapshotCache.ts` belongs to the retained view and deduplicates
in-flight reads. It keeps at most eight completed snapshots with a 32 MiB
text target, allowing one oversized PR to remain complete. Eviction drops cache
ownership only, never mounted content or pending requests.

The HTTP Git adapter emits `gitPushEvents` only after a successful push, with
the runtime captured at request start. Matching runtime/directory snapshots are
invalidated synchronously. A visible PR comparison refreshes immediately; a
hidden one waits until activation. Old pre-push reads cannot overwrite the new
snapshot. Explicit Refresh always reads again. Terminal and external-client
pushes require that manual refresh. Local status polls never invalidate PRs.
Walkthrough also retains its last PR read across visibility changes and reloads
after push, source, model or language changes. The PR picker retains its list
on panel switches; opening the picker or changing search still refreshes it.

Working-tree mutations are unavailable for PR snapshots, and "Load full files"
does not apply to them. Expanding collapsed context on one file works: the
expander asks `useGitComparison.fetchFullFile`, which reads both sides of that
file from GitHub through `/api/walkthrough/pr-file` (merge base and PR head),
never from disk, so local edits and unfetched fork commits cannot leak in or
block it. Existing inline comment controls still attach selected code to chat.
Changes hands its PR source to walkthrough; walkthrough's Changes action opens
PR mode with the shared selection. Picking a PR never generates a walkthrough.

Web, Electron, hosted mobile and Capacitor use the server route. VS Code keeps
PR comparison unavailable, like the other server-backed comparison modes.

Most focused tests use Bun. `MultiFileDiffEntry.vitest.tsx` exercises the real
diff component through the web workspace's Vitest runner because its transitive
UI imports require Vite asset transforms. The web test configuration includes
UI `*.vitest.tsx` fixtures; the isolated Bun runner intentionally does not.

ChatGPTWorkspace retains one isolated website webview after its first explicit opening. The optional website history folder moves website sidebar navigation into Open Carter, while the website keeps its composer, model selection and account memory. Full mode restores website navigation without reloading or replacing a draft. The origin-gated DOM adapter in lib/chatgpt/website.ts reads navigation metadata only and validates snapshots. Visible views read every three seconds, one at a time; hidden views suspend reads and stale completions are rejected. The loaded sidebar is partial history; older history uses the website scroll viewport, with Full ChatGPT as fallback. Website layout changes produce an explicit unavailable state. The view exposes no OpenCode browser controller or app preload.

MuseWorkspace retains one website guest and one Open Carter tab for the complete standalone `https://muse.ai/` website in `persist:open-carter-muse`, separate from ChatGPT. Electron navigation events supply the current exact-origin title and an eligible current URL. Eligibility requires HTTPS, the exact origin and no credentials, query or fragment. Live metadata clears during loading, failure or external sign-in navigation; it is never interpreted as a chat identifier. Explicit pinning saves the observed URL and title in the device-local `open-carter.muse.saved-pages.v1` snapshot. Hydration validates entries and deduplicates URLs without guessing routes. The existing safe-storage adapter keeps writes in memory if durable storage is unavailable. Saved links remain through runtime resets and sign-out, and can be removed locally without deleting website data. No DOM snapshots, messages, cookies or account stores are read. Muse keeps its own sidebar, memory, goals and artifacts. Repeated selection resumes the same guest and preserves the current page and draft; the first Home request is fulfilled by src without a second load. Back, Forward and Reload are explicit controls; Full Muse focuses the complete retained website without navigation. Popup links use the main-process in-place navigation handler rather than creating windows. Main-frame load failure offers Reload. A visible notice distinguishes local saved pages from unverified account-history mirroring. The browser controller cannot inspect this partition; signed-in navigation and conversation IDs remain blocked on real account DOM evidence. Web, VS Code, hosted mobile, Capacitor and remote desktop do not expose this view.

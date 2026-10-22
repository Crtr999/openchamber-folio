# OpenChamber Mobile

Capacitor shell for the dedicated OpenChamber mobile web surface.

The mobile package reuses the web build, then rewrites `mobile.html` to `index.html` in `packages/mobile/dist` so native iOS/Android always launch `MobileApp` instead of the hosted surface selector.

## Runtime Model

- The native app bundles the mobile UI only; it does not embed the OpenChamber web server or OpenCode server.
- On first launch in Capacitor, the app shows a connection screen for an existing OpenChamber server.
- Connections are saved locally in the app and can be managed from `Instances` in the sessions drawer footer (a persistent left sidebar on tablets).
- The connection screen and the `Instances` entry are Capacitor-only. Hosted `mobile.html` in a normal browser keeps the regular web behavior.
- Phones and tablets share one navigation model: a sessions drawer/sidebar on the left, the workspace drawer (Changes / Files / Terminal / Notes / MCP) on the right, and no overflow menu. Tablets differ only in that the sessions list is a resizable persistent sidebar and the header dropdowns are anchored popovers.
- The tablet layout is a live size class (`useTabletLayout`), not a device check: any surface whose short side is at least 600px gets it, and the workspace only becomes a side panel where the width can host the sidebar, the panel and a readable chat at once. Book foldables therefore pick it up when unfolded, keep the portrait layout in both orientations (their long side is barely wider than a tablet's short one), and drop back to the phone layout when folded shut. The Android activity declares the matching `configChanges`, so folding resizes the WebView instead of recreating it.
- Password-protected OpenChamber servers can be unlocked from the mobile app. The app stores the issued client token with the saved connection.
- The Terminal workspace surface runs its PTY on the active OpenChamber server over the shared authenticated runtime transport; it never opens a local shell on the phone or tablet. Closing the surface detaches the renderer while the server session remains available for reattachment. On touch devices, dragging scrolls the buffer while long-pressing and dragging selects terminal text.
- Downloads (file viewer, saved message images) open the native share sheet instead of a browser download, because a WebView has no download manager. iOS uses the Web Share API; Android WebView lacks it, so Android goes through the app-local `FileShare` plugin (`android/app/src/main/java/com/openchamber/app/FileSharePlugin.java`, registered in `MainActivity`), which writes the file to the cache directory and shares it through the manifest's `FileProvider`. The shared helper is `packages/ui/src/lib/nativeFileShare.ts`.
- The Changes workspace has a top-level Changes / Branch / Commit / Pull Requests selector. Checkout, Sync, staging, and commit controls appear only under Changes. Comparisons show a read-only file list that opens one diff at a time. Their shared source pickers use bottom sheets on phones and anchored popovers on tablets. Commit lists the latest 50 commits of the checked-out branch. Pull Requests shows the published GitHub diff, excluding local edits and unpushed commits, with search and an explicit refresh action. Closing the workspace preserves the current detail and suspends comparison reads; changing repository or instance resets navigation, and a new file link from chat opens the working-tree diff.

## Commands

Run these from `packages/mobile`, or use the root `mobile:*` aliases.

- `bun run build`: builds `packages/web` and prepares mobile web assets.
- `bun run build:assets`: prepares mobile assets from an existing `packages/web/dist` build; the root workspace build uses this to avoid rebuilding web.
- `bun run sync`: prepares assets and runs `cap sync`.
- `bun run add:ios`: creates the native iOS project.
- `bun run add:android`: creates the native Android project.
- `bun run build:android:debug`: builds a debug Android APK without launching an emulator.
- `bun run build:ios:simulator`: builds an iOS Simulator app without launching Xcode or Simulator.
- `bun run sim:run`: boots a simulator if needed, installs the built iOS app, and launches it.
- `bun run sim:dev`: one-command dev loop — builds the simulator app, installs + launches it, starts the `serve-sim` stream, and prints the preview URL; Ctrl+C stops the stream. Pass `--no-build` to skip the build step.
- `bun run sim:serve`: starts `serve-sim` in detached JSON mode and prints the browser preview URL.
- `bun run sim:list`: lists running `serve-sim` streams.
- `bun run sim:kill`: stops running `serve-sim` streams.
- `bun run open:ios`: opens the iOS project.
- `bun run open:android`: opens the Android project.

## Headless Quickstart

```sh
bun run build
bun run sync
bun run build:ios:simulator
bun run build:android:debug
```

These commands build and sync the native projects without launching Xcode, Android Studio, Simulator, or an emulator.

## Local Tooling

The default scripts assume the local Homebrew/Xcode paths prepared for this workspace:

- Xcode: `/Applications/Xcode.app/Contents/Developer`
- JDK 21: `/opt/homebrew/opt/openjdk@21`
- Android SDK: `/opt/homebrew/share/android-commandlinetools`

Override `DEVELOPER_DIR`, `JAVA_HOME`, `ANDROID_HOME`, or `ANDROID_SDK_ROOT` when using a different local setup.

Required local tools:

- Xcode with iOS Simulator support.
- CocoaPods for iOS dependency installation.
- JDK 21 for Android Gradle builds.
- Android SDK command-line tools with platform/build-tools 35.

## Troubleshooting

- If `xcodebuild` reports that the active developer directory is Command Line Tools, keep using the provided scripts or set `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.
- If Android builds fail with `Unable to locate a Java Runtime` or `source release: 21`, install/use JDK 21 and set `JAVA_HOME` accordingly.
- If Android SDK packages are missing, install `platform-tools`, `platforms;android-35`, and `build-tools;35.0.0`, then accept SDK licenses.
- If CocoaPods cannot find Capacitor pods after reinstalling dependencies, run `bun install` from the workspace root, then rerun `bun run sync`.
- If connecting to a remote OpenChamber server fails from the app while `/health` works in curl, check that the server build includes the packaged-client CORS allowlist for `capacitor://localhost` and local dev origins.
- If `serve-sim` preview says the stream is not producing frames, check the raw MJPEG stream before assuming the simulator stopped. In prior testing the raw stream worked while the browser preview UI stayed stale.

## Generated Assets

The native projects currently use Capacitor-generated launcher and splash assets. Replace them before release branding work.

## Home Screen companion

The hosted `/mobile.html` entry uses the same MobileApp and ChatView as the native shell. It now registers the production push service worker and links `/mobile.webmanifest`, whose stable start URL keeps the mobile renderer on launch. `/mobile.html?dictate=1` presents a user-triggered shortcut to the existing composer dictation engine. It never starts the microphone automatically or sends a draft without the normal dictation/send controls. Native schemes skip service-worker registration.

Follow-ups opens project-owned daily schedules through `/api/projects/:projectId/companion`. The normal desktop scheduler owns those same records and result sessions. This is explicit daily monitoring, not autonomous enrollment from every chat or a general-purpose notification ranking system. Both devices must connect to the same server to see the same sessions and artifacts. Existing Mac-local sessions are not replicated by opening a cloud instance. See `deploy/companion/README.md` for deployment and remaining real-device checks.

## Personal iPhone companion

The native app keeps existing chats, new chats, attachment/artifact viewing, server terminal work and project follow-ups in the same MobileApp. These features use the selected server as authority, so the Mac must connect to that server too. A separate cloud server does not synchronize an existing Mac-local database automatically.

On iOS 18+, the widget extension now offers a Dictate to Carter Control Center control and discoverable App Intent. `openchamber://dictate` opens the normal recording controls for the current composer. The user starts capture and chooses insert/send. The URL cannot supply text, submit a message or start recording. Cold-launch URLs are read after listener registration; a newer live URL takes precedence.

Native remote push requires an Apple Developer membership, valid signing for all app/extension IDs and configured APNs delivery. Free weekly Personal Team installation is not equivalent to native background push. The existing iOS project contains upstream team, bundle and App Group values. Before personal device distribution, configure all three targets and their shared App Group consistently under the user's team. Do not use upstream signing credentials. The optional `deploy/companion/native-push.compose.yaml` uses a separately mounted private Apple push key for a personally signed app. No signing key belongs in the app bundle.

### Free weekly personal builds

The default build keeps APNs and upstream bundle identifiers. For a separate personal build, pass Xcode settings `CARTER_BUNDLE_ID`, `CARTER_APP_GROUP`, `CARTER_DISPLAY_NAME`, `CARTER_URL_SCHEME=opencarter`, your `DEVELOPMENT_TEAM`, and `CARTER_APP_ENTITLEMENTS=App/PersonalTeam.entitlements`. This optional entitlement file retains the shared widget container and omits APNs. The native bridge reports the provisioned APNs capability before JavaScript starts, so unsupported builds do not request/register remote push. Apple Personal Team installation expires and must be renewed weekly; server results still persist while the app is closed, but cannot alert through Apple remote push. Keep the same personal bundle ID and app group on subsequent builds to retain on-device data. Both `openchamber:` and `opencarter:` deep links are accepted.

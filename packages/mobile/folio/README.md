# Folio for iPhone

A standalone iPhone app for Folio notes and AI chat. Notes live on the phone (IndexedDB), and chats go straight from the phone to OpenCode Zen or OpenRouter, so it works with the Mac off. It never connects to an OpenChamber server.

It reuses the Capacitor packages installed under `packages/mobile/node_modules`, so there is nothing extra to install.

## Build and install (free Apple ID)

1. Build the web assets from the repo root: `bun run --cwd packages/web build`.
2. From this folder: `node scripts/prepare-web-assets.mjs && ../node_modules/.bin/cap sync ios`.
3. Open `ios/App/App.xcodeproj` in Xcode, choose your Personal Team under Signing & Capabilities, pick your iPhone, and press Run.

With a free Apple ID the app must be reinstalled from Xcode every 7 days. Notes stay on the phone across reinstalls.

## Moving notes

On the Mac, choose ⋯ → Backup for iPhone, AirDrop the file to the phone, then Settings → Import backup. Attachments stay on the Mac.

## Theme

Settings → Appearance offers the same themes as the Mac, and writes the same choice, so a theme picked on either device reaches the other over the paired sync. The most recent change wins, which means a phone that has been offline for a while takes the Mac's theme and a Mac takes the phone's only when the phone's choice is the newer one. Colours are never copied: each device draws the theme from its own copy of the presets.

#!/bin/bash
# Detached installer for Open Carter.
# Runs under launchd, so it is independent of the app process it replaces.
# One-shot and self-guarded: repeated runs are no-ops (step 0).

SRC="$HOME/Developer/openchamber/packages/electron/dist/mac-arm64/Open Carter.app"
DST="/Applications/Open Carter.app"
BACKUP="/Applications/Open Carter.app.backup"
LOG="$HOME/Developer/openchamber/install.log"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

log "=== installer start (pid $$) ==="

# 0. Idempotence guard: if the installed app already matches the build, do nothing.
if [ -f "$SRC/Contents/Resources/app.asar" ] && [ -f "$DST/Contents/Resources/app.asar" ]; then
  if [ "$(shasum -a 256 "$SRC/Contents/Resources/app.asar" | awk '{print $1}')" = "$(shasum -a 256 "$DST/Contents/Resources/app.asar" | awk '{print $1}')" ]; then
    log "already up to date (app.asar matches build), nothing to do"
    exit 0
  fi
fi

# 1. Verify the build before touching anything.
if [ ! -d "$SRC" ] || [ ! -d "$SRC/Contents/MacOS" ]; then
  log "FAIL: build missing or incomplete at $SRC"
  exit 1
fi
if [ ! -f "$SRC/Contents/Resources/app.asar" ]; then
  log "FAIL: app.asar missing in build"
  exit 1
fi
log "build verified: $(du -sh "$SRC" | cut -f1)"

# 2. Give the user (and the agent's final message) a moment, then ask the app to quit on its own.
sleep 25
log "requesting quit"
osascript -e 'tell application "Open Carter" to quit' >/dev/null 2>&1

# 3. Wait for every helper process to exit.
for i in $(seq 1 40); do
  n=$(pgrep -f "Open Carter.app" | wc -l | tr -d ' ')
  [ "$n" = "0" ] && break
  sleep 1
done

# 4. Escalate only if it is still alive.
n=$(pgrep -f "Open Carter.app" | wc -l | tr -d ' ')
if [ "$n" != "0" ]; then
  log "still $n process(es) after 40s, sending TERM"
  pkill -f "Open Carter.app" >/dev/null 2>&1
  sleep 5
  n=$(pgrep -f "Open Carter.app" | wc -l | tr -d ' ')
  if [ "$n" != "0" ]; then
    pkill -9 -f "Open Carter.app" >/dev/null 2>&1
    sleep 3
  fi
fi
log "app stopped"

# 5. Swap, keeping the old bundle as a rollback copy.
rm -rf "$BACKUP"
if [ -d "$DST" ]; then
  mv "$DST" "$BACKUP" && log "moved current install to backup" || log "WARN: could not move old install"
fi

# ditto preserves resource forks, extended attributes and the code signature.
if /usr/bin/ditto "$SRC" "$DST"; then
  log "install succeeded: $(du -sh "$DST" | cut -f1)"
else
  log "FAIL: ditto failed, rolling back"
  rm -rf "$DST"
  [ -d "$BACKUP" ] && mv "$BACKUP" "$DST"
  exit 1
fi

# 6. Confirm the new binary is real before launching it.
if [ ! -x "$DST/Contents/MacOS/Open Carter" ]; then
  log "FAIL: installed binary is not executable, rolling back"
  rm -rf "$DST"
  [ -d "$BACKUP" ] && mv "$BACKUP" "$DST"
  exit 1
fi

# 6b. Guard the code signature. macOS will not persist privacy grants (screen
# recording, system audio, microphone) for a bundle whose seal does not verify,
# which shows up as "Allow" never sticking. The build itself verifies; this only
# repairs the case where the installed bundle was hand-patched after signing.
if codesign --verify --strict "$DST" >/dev/null 2>&1; then
  log "signature verified after install"
else
  log "WARN: installed bundle failed signature verification, re-sealing"
  ENTS="$HOME/Developer/openchamber/.open-carter-entitlements.plist"
  if codesign -d --entitlements :- "$DST" > "$ENTS" 2>/dev/null && [ -s "$ENTS" ] \
     && codesign --force --sign - --options runtime --generate-entitlement-der --entitlements "$ENTS" "$DST" >> "$LOG" 2>&1; then
    log "re-signed installed bundle ad hoc with the bundled entitlements"
  else
    log "WARN: re-sign failed; privacy grants may not persist"
  fi
  rm -f "$ENTS"
fi

# 7. Relaunch.
open -a "$DST"
log "relaunched"

# 8. Self-clean so this one-shot job can never fire again.
rm -f "$HOME/Library/LaunchAgents/com.opencarter.install.plist"
log "=== installer done ==="

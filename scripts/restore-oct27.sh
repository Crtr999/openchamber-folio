#!/bin/bash
# One-shot, detached restore of Open Carter to the Tuesday Oct 27 2026 build
# (commit 9e3d3779b, "General: rules and memory files editable in the friend studio").
# Runs detached so it survives the app quit that replaces it.
set -u

SRC="$HOME/Developer/openchamber-oct27/packages/electron/dist/mac-arm64/Open Carter.app"
DST="/Applications/Open Carter.app"
LOG="$HOME/Developer/openchamber/oct27-restore.log"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

log "=== oct27 restore start (pid $$)"
log "source build: $SRC"

# 1. Pre-flight: the source build must exist, verify, and be the Oct 27 baseline.
if [ ! -x "$SRC/Contents/MacOS/Open Carter" ] || [ ! -f "$SRC/Contents/Resources/app.asar" ]; then
  log "FAIL: source build incomplete"; exit 1
fi
if ! codesign --verify --strict "$SRC" >/dev/null 2>&1; then
  log "FAIL: source build signature does not verify"; exit 1
fi
if [ "$(grep -a -o 'zdr-lock' "$SRC/Contents/Resources/app.asar" | wc -l | tr -d ' ')" != "0" ]; then
  log "FAIL: source build contains post-Oct-27 (zdr-lock) code"; exit 1
fi
log "pre-flight ok: signed, verifies, no post-Oct-27 code"

# 2. Give the chat reply time to land, then stop the app with SIGTERM (its documented quit path).
sleep 40
log "sending SIGTERM to the app"
pkill -TERM -f "Open Carter.app/Contents/MacOS/Open Carter" >/dev/null 2>&1
for i in $(seq 1 45); do
  n=$(pgrep -f "Open Carter.app" | wc -l | tr -d ' ')
  [ "$n" = "0" ] && break
  sleep 1
done
n=$(pgrep -f "Open Carter.app" | wc -l | tr -d ' ')
if [ "$n" != "0" ]; then
  log "still $n process(es) after 45s, escalating"
  pkill -f "Open Carter.app" >/dev/null 2>&1; sleep 5
  pgrep -f "Open Carter.app" >/dev/null 2>&1 && { pkill -9 -f "Open Carter.app" >/dev/null 2>&1; sleep 3; }
fi
log "app stopped (remaining: $(pgrep -f 'Open Carter.app' | wc -l | tr -d ' '))"

# 3. Swap in the Oct 27 build.
rm -rf "$DST"
if /usr/bin/ditto "$SRC" "$DST"; then
  log "copied Oct 27 build into /Applications"
else
  log "FAIL: ditto failed"; exit 1
fi
if [ "$(shasum -a 256 "$SRC/Contents/Resources/app.asar" | awk '{print $1}')" = "$(shasum -a 256 "$DST/Contents/Resources/app.asar" | awk '{print $1}')" ]; then
  log "app.asar matches the built Oct 27 tree"
else
  log "FAIL: installed app.asar does not match the build"; exit 1
fi
if codesign --verify --strict "$DST" >/dev/null 2>&1; then
  log "signature verified after install ($(codesign -dv "$DST" 2>&1 | grep -m1 Authority | sed 's/Authority=//'))"
else
  log "WARN: installed bundle fails signature verification"
fi

# 4. Relaunch and confirm it came up.
open -a "$DST"
sleep 25
n=$(pgrep -f "Open Carter.app" | wc -l | tr -d ' ')
main=$(pgrep -f "Open Carter.app/Contents/MacOS/Open Carter" | head -1)
log "relaunched: $n Open Carter process(es), main pid ${main:-none}"
log "=== oct27 restore done"

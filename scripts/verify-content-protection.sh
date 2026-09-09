#!/bin/bash
#
# Empirically check the §21 privacy requirement: does the overlay stay out of ordinary
# screen capture? Electron's setContentProtection() is write-only - there is no getter -
# so a screenshot is the only honest test.
#
# Run from Terminal.app, NOT from an agent or CI. See the permission gate below.
#
set -uo pipefail
cd "$(dirname "$0")/.."

OUT=${1:-/tmp/overlay-capture}
mkdir -p "$OUT"
npm run --silent build

capture () {  # $1 = label, $2... = extra electron args
  local label=$1; shift
  ./node_modules/.bin/electron . "$@" >/dev/null 2>&1 &
  local pid=$!
  sleep 3                                    # let the window paint
  screencapture -x "$OUT/$label.png" 2>/dev/null
  local rc=$?
  kill $pid 2>/dev/null; wait $pid 2>/dev/null
  return $rc
}

echo "1/2  capturing WITH content protection..."
capture protected
echo "2/2  capturing WITHOUT content protection..."
capture unprotected --no-content-protection

# ---- Permission gate --------------------------------------------------------------
# THE TRAP: without Screen Recording permission, screencapture yields a blank or black
# image. The overlay is "absent" from it - so the check appears to pass, for entirely the
# wrong reason. Refuse to conclude anything unless the capture clearly contains a desktop.
MIN_BYTES=50000
for f in protected unprotected; do
  if [ ! -f "$OUT/$f.png" ]; then
    echo; echo "INCONCLUSIVE: screencapture produced no file for '$f'."
    echo "  Grant Terminal permission under System Settings > Privacy & Security >"
    echo "  Screen & System Audio Recording, then re-run."
    exit 3
  fi
  size=$(stat -f%z "$OUT/$f.png")
  if [ "$size" -lt "$MIN_BYTES" ]; then
    echo; echo "INCONCLUSIVE: '$f.png' is only ${size} bytes - almost certainly a blank"
    echo "  capture from a missing Screen Recording permission, not a real screenshot."
    echo "  A blank image would make content protection look like it works. Fix the"
    echo "  permission and re-run before trusting any result."
    exit 3
  fi
done

echo
echo "Both captures look like real screenshots. Compare them by eye:"
echo "  open $OUT/unprotected.png   <- overlay SHOULD be visible (dark HUD, 'Listening')"
echo "  open $OUT/protected.png     <- overlay should be ABSENT"
echo
echo "If the overlay appears in BOTH, setContentProtection is not taking effect."
echo "If it appears in NEITHER, the window never rendered - not a protection result."

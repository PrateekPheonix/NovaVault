#!/bin/bash
# Builds the Phase 0 system-audio capture spike. Requires only Xcode Command Line Tools.
set -euo pipefail
cd "$(dirname "$0")"
clang -fobjc-arc -O2 \
  -framework Foundation -framework CoreAudio -framework AudioToolbox \
  -o audiotap main.m
echo "built: $(pwd)/audiotap"

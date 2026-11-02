#!/usr/bin/env bash
# Test media for tests/ae/integration.jsx (needs ffmpeg). Output: build/ae_media
set -euo pipefail
cd "$(dirname "$0")/../.."
out=build/ae_media
mkdir -p "$out"
ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }

# 10 s, 24 fps, TC 01:00:00:00, with stereo audio
ff -f lavfi -i "testsrc2=size=320x180:rate=24:duration=10" -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=10" \
   -c:v prores_ks -profile:v 0 -c:a pcm_s16le -ac 2 -timecode 01:00:00:00 "$out/A001.mov"
# 20 s, 24 fps, TC 02:00:00:00, picture only
ff -f lavfi -i "testsrc=size=320x180:rate=24:duration=20" -c:v prores_ks -profile:v 0 -timecode 02:00:00:00 "$out/B002.mov"
# image sequence plate.1001.png - plate.1100.png
mkdir -p "$out/plate"
ff -f lavfi -i "smptebars=size=320x180:rate=24" -frames:v 100 -start_number 1001 "$out/plate/plate.%04d.png"
# 20 s music
ff -f lavfi -i "sine=frequency=220:sample_rate=48000:duration=20" -ac 2 -c:a pcm_s16le "$out/music.wav"
ls -R "$out" | head -8

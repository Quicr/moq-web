#!/bin/bash
set -euo pipefail

# Combine two MOCHA Meet recordings into a side-by-side MP4
# Also produces individual MP4 conversions from webm
#
# Usage:
#   ./combine-recordings.sh <bob.webm> <alice.webm> [output-dir]
#
# Example:
#   ./combine-recordings.sh ~/Downloads/bob.webm ~/Downloads/alice.webm ~/Downloads/

if [ $# -lt 2 ]; then
  echo "Usage: $0 <bob-recording.webm> <alice-recording.webm> [output-dir]"
  echo ""
  echo "  bob-recording:   Left panel (30% width) - publisher/bot view"
  echo "  alice-recording: Right panel (70% width) - subscriber view"
  echo "  output-dir:      Where to write MP4s (default: same dir as alice file)"
  exit 1
fi

BOB_FILE="$1"
ALICE_FILE="$2"
OUTPUT_DIR="${3:-$(dirname "$ALICE_FILE")}"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)

echo "═══════════════════════════════════════════════════"
echo "  MOCHA Meet — Recording Combiner"
echo "═══════════════════════════════════════════════════"
echo ""

# Step 1: Convert individual files to MP4
echo "▸ Converting individual recordings to MP4..."
echo "  → Bob: $BOB_FILE"
ffmpeg -y -loglevel warning \
  -i "$BOB_FILE" \
  -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p \
  -c:a aac -b:a 128k \
  "${OUTPUT_DIR}/mocha-meet-bob-${TIMESTAMP}.mp4"
echo "  ✓ ${OUTPUT_DIR}/mocha-meet-bob-${TIMESTAMP}.mp4"

echo "  → Alice: $ALICE_FILE"
ffmpeg -y -loglevel warning \
  -i "$ALICE_FILE" \
  -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p \
  -c:a aac -b:a 128k \
  "${OUTPUT_DIR}/mocha-meet-alice-${TIMESTAMP}.mp4"
echo "  ✓ ${OUTPUT_DIR}/mocha-meet-alice-${TIMESTAMP}.mp4"

# Step 2: Combine side-by-side (30/70 split, 1920x720)
echo ""
echo "▸ Combining into 70/30 split..."
echo "  → Bob (30% left) | Alice (70% right)"
COMBINED="${OUTPUT_DIR}/mocha-meet-combined-${TIMESTAMP}.mp4"

ffmpeg -y -loglevel warning \
  -i "$BOB_FILE" \
  -i "$ALICE_FILE" \
  -filter_complex "\
    [0:v]scale=576:720,setsar=1[bob];\
    [1:v]scale=1344:720,setsar=1[alice];\
    [bob][alice]hstack=inputs=2[vid];\
    [vid]drawtext=text='Bobs View':fontsize=28:fontcolor=white:x=20:y=20:box=1:boxcolor=black@0.5:boxborderw=8,\
         drawtext=text='Alices View':fontsize=28:fontcolor=white:x=596:y=20:box=1:boxcolor=black@0.5:boxborderw=8[out]" \
  -map "[out]" -map 1:a \
  -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p \
  -c:a aac -b:a 128k \
  -shortest \
  "$COMBINED"

echo "  ✓ $COMBINED"

# Summary
echo ""
echo "═══════════════════════════════════════════════════"
echo "  Output files:"
echo "    Individual: mocha-meet-bob-${TIMESTAMP}.mp4"
echo "    Individual: mocha-meet-alice-${TIMESTAMP}.mp4"
echo "    Combined:   mocha-meet-combined-${TIMESTAMP}.mp4"
echo "═══════════════════════════════════════════════════"

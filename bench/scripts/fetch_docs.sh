#!/usr/bin/env bash
# Fetch the ffmpeg documentation corpora. ffmpeg.org serves git-trunk docs (not
# release-versioned), so the reproducibility anchor is the fetch date, recorded
# in corpus/PROVENANCE.txt. Raw HTML is gitignored (large, reproducible here);
# the parsed JSONL snapshot is committed as the stable benchmark input.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p corpus/raw
CLI_URL="https://ffmpeg.org/ffmpeg.html"
ALL_URL="https://ffmpeg.org/ffmpeg-all.html"

curl -sSL -o corpus/raw/ffmpeg-cli.html "$CLI_URL"
curl -sSL -o corpus/raw/ffmpeg-all.html "$ALL_URL"

FETCHED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
  echo "fetched_utc: $FETCHED"
  echo "cli_url:     $CLI_URL"
  echo "all_url:     $ALL_URL"
  echo "cli_sha256:  $(sha256sum corpus/raw/ffmpeg-cli.html | cut -d' ' -f1)"
  echo "all_sha256:  $(sha256sum corpus/raw/ffmpeg-all.html | cut -d' ' -f1)"
  echo "note:        ffmpeg.org serves git-trunk docs; fetch date is the version anchor."
} > corpus/PROVENANCE.txt

echo "Fetched at $FETCHED"
cat corpus/PROVENANCE.txt

echo
echo "Next: python3 scripts/parse_docs.py corpus/raw/ffmpeg-cli.html corpus/parsed/cli.jsonl cli"
echo "      python3 scripts/parse_docs.py corpus/raw/ffmpeg-all.html corpus/parsed/all.jsonl all"

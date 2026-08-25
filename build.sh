#!/usr/bin/env bash

set -euo pipefail

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
archive="$project_dir/memory-saver.zip"

command -v zip >/dev/null 2>&1 || {
  echo "Build failed: the 'zip' command is required." >&2
  exit 1
}

rm -f -- "$archive"

cd -- "$project_dir"
zip -X -r -q "$archive" manifest.json icons src README.md CHANGELOG.txt \
  -x '*/.DS_Store' '*/Thumbs.db'

echo "Built $archive"

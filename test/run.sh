#!/usr/bin/env bash
# Run all node-based tests. Exit non-zero if any fail.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
cd "$(dirname "$here")"
for f in test/*.test.js; do
  echo "== $f =="
  node "$f"
done

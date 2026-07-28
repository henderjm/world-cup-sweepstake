#!/usr/bin/env sh
# Run one metrics query (or all of them) against the production D1 database.
#
#   ./scripts/metrics/run.sh 01-league-funnel.sql
#   ./scripts/metrics/run.sh              # every query, in order
#
# Every query in this directory is a single read-only SELECT with no bound
# parameters, so it goes through `--command` verbatim. Nothing here writes.
set -eu

dir=$(dirname "$0")

run_one() {
  echo ""
  echo "===================================================================="
  echo "== $(basename "$1")"
  echo "===================================================================="
  npx wrangler d1 execute squad-goals --remote --command "$(cat "$1")"
}

if [ $# -eq 0 ]; then
  for f in "$dir"/*.sql; do run_one "$f"; done
else
  for name in "$@"; do
    f="$dir/$(basename "$name")"
    [ -f "$f" ] || { echo "no such query: $name" >&2; exit 1; }
    run_one "$f"
  done
fi

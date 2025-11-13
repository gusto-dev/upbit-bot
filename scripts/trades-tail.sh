#!/usr/bin/env bash
set -euo pipefail
PATH_ARG="${1:-analytics/trades.log}"
LINES=${2:-50}
if [[ ! -f "$PATH_ARG" ]]; then
  echo "Log file not found: $PATH_ARG" 1>&2
  exit 1
fi
# tail last N lines
tail -n "$LINES" "$PATH_ARG"

#!/usr/bin/env bash
set -euo pipefail
PATH_ARG="${1:-analytics/trades.log}"
if [[ ! -f "$PATH_ARG" ]]; then
  echo "Log file not found: $PATH_ARG" 1>&2
  exit 1
fi
# follow the file
trap 'exit 0' INT
tail -n 50 -f "$PATH_ARG"

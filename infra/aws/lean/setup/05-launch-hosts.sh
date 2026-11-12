#!/bin/sh
# Operator-run paid host creation; review the prepared resource plan first.
set -eu
set +x
SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 -B "$SCRIPT_DIRECTORY/setup_resources.py" launch "$@"

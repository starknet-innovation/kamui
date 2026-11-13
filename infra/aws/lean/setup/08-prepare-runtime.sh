#!/bin/sh
# Operator-run installation phase. Keep private state; no wallet startup.
set -eu
set +x
SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 -B "$SCRIPT_DIRECTORY/../install/install.py" runtime "$@"

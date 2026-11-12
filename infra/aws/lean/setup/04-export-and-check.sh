#!/bin/sh
# Operator-run only. AWS metadata/results remain private.
set -eu
set +x
SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 -B "$SCRIPT_DIRECTORY/setup_resources.py" export "$@"

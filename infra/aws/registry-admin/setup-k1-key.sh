#!/bin/sh
# Operator setup; AWS changes require explicit user authorization.
set -eu
SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 -B "$SCRIPT_DIRECTORY/setup_k1_key.py" "$@"

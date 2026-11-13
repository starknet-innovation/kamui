#!/bin/sh
# Operator-run, after 08 and after 12 --execute. Stores each host's runtime files in its own
# Secrets Manager secret. Never reads a secret value back, and never touches the relayer key:
# put that into kamui-sepolia/backend/relayer-private-key yourself.
set -eu
set +x
SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 -B "$SCRIPT_DIRECTORY/../install/install.py" secrets "$@"

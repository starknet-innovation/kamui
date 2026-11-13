#!/bin/sh
# Operator-run. Upgrade a started wallet: prepare (stop, back up, fence), install, finish.
# Read infra/aws/lean/install/UPGRADE.md first. Writes stay closed until 14 reopen.
set -eu
set +x
SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 -B "$SCRIPT_DIRECTORY/../install/upgrade.py" "$@"

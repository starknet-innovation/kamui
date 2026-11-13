#!/bin/sh
# Operator-run. Approves an app for sponsored calls: creates its server credential in a private
# file (never printed) and adds the app to the funding policy decision. Then run 08, 13 and
# `14-reopen-after-reboot.sh reload-runtime` to apply it. `status` lists approved apps.
set -eu
set +x
SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 -B "$SCRIPT_DIRECTORY/../install/sponsor_app.py" "$@"

#!/bin/sh
# Operator-run. Archives the completed release so 07-10 can build and install the next one.
# Hosts refuse the replacement if the wallet ever started or wrote state. No AWS calls here.
set -eu
set +x
SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 -B "$SCRIPT_DIRECTORY/../install/install.py" supersede "$@"

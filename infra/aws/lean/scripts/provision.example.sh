#!/bin/sh
# OPERATOR ONLY. Existing reviewed resources; one paid launch, no automatic retry.
# Fill EXPECTED_ACCOUNT from an independent trusted record, never from this launch's STS result.
set -eu
set +x
SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 -B "$SCRIPT_DIRECTORY/provision.py"

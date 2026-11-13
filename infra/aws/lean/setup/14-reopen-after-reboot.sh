#!/bin/sh
# Operator-run after a host reboot. Each backend boot blocks the restore gate; this checks the
# boot fence, replay window and recovery jobs over SSM, then (after you type REOPEN) acknowledges
# the gate in restored mode on YOUR attestation and starts the stack. Subcommands:
#   status | fence | reopen --review-ref <ref> | enable-boot
# Never schedule it: running `reopen` is the operator attestation.
set -eu
set +x
SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 -B "$SCRIPT_DIRECTORY/../install/reopen.py" "$@"

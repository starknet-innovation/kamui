#!/bin/sh
# Operator-run. Adds each host's runtime secrets, their KMS key and the host's single decrypt
# path to the existing identity stacks through reviewed CloudFormation change sets.
# First run: creates and checks the change sets, changes nothing. Then: --execute applies them.
set -eu
set +x
SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 -B "$SCRIPT_DIRECTORY/setup_resources.py" identity-secrets "$@"

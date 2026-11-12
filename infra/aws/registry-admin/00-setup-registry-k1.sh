#!/bin/sh
# Operator-run sequence. Stop on any failure; no automatic mutation retries.
set -eu
SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
printf '%s\n' 'Step 1/3: checking or creating IAM roles'
"$SCRIPT_DIRECTORY/01-create-registry-roles.sh" "$@"
printf '%s\n' 'Step 2/3: checking or configuring role profiles'
"$SCRIPT_DIRECTORY/02-create-registry-profiles.sh" "$@"
printf '%s\n' 'Step 3/3: checking or creating the dedicated k1 key'
"$SCRIPT_DIRECTORY/03-create-registry-k1-key.sh" "$@"

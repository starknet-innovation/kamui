#!/usr/bin/env bash
# Python's shared fcntl lock is portable across the local macOS drill and Linux host.
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec python3 "$here/restore.py" "$@"

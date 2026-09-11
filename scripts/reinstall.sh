#!/bin/sh
# Refresh the profile's installed copy from this working tree.
#
# The plugin is installed with pnpm's `file:` protocol, which copies the
# package into the profile rather than symlinking it. That keeps the installed
# copy independent of this repo, at the cost of needing this step after every
# edit. Re-running `add` refreshes an existing `file:` dependency in place —
# removing first is not required.
#
# Usage: scripts/reinstall.sh [profile]      (default: dsh-tui)
set -eu

PROFILE="${1:-${DSH_PROFILE:-dsh-tui}}"
HERE=$(cd "$(dirname "$0")/.." && pwd)

if ! command -v dsh >/dev/null 2>&1; then
  echo "reinstall: dsh not found on PATH" >&2
  exit 1
fi

dsh plugin --profile "$PROFILE" add "file:$HERE"

echo
echo "Installed $HERE into profile '$PROFILE'."
echo "Restart dsh-tui to load the new copy (the plugin mounts at startup)."

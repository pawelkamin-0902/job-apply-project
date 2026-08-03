#!/bin/bash
# Syncs this project to the VMware shared folder so changes show up on the Windows host.
set -e
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/"
DEST="/mnt/hgfs/auto-apply/job-apply-project/"

# extension/test-forms/captured/ is excluded from --delete's reach: it holds real "Save Sample"
# captures written directly by a live companion-service instance, not code — this local
# checkout never has a copy of it, so a plain --delete sync would silently wipe out real
# captured data on every run (confirmed happened at least once).
rsync -a --delete --exclude 'venv' --exclude '__pycache__' --exclude 'node_modules' --exclude 'extension/test-forms/captured' --exclude 'companion-service/.portal-browser-profile' --exclude 'companion-service/.chatgpt-browser-profile' "$SRC" "$DEST"
echo "Synced $SRC -> $DEST"

#!/bin/bash
# Syncs this project to the VMware shared folder so changes show up on the Windows host.
set -e
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/"

# Prefer the classic /mnt/hgfs path; fall back to a user-mounted vmhgfs-fuse share when
# /mnt/hgfs is empty/unmounted (common after VM reboot before root remount).
DEST=""
for candidate in \
  "/mnt/hgfs/auto-apply/job-apply-project/" \
  "/tmp/hgfs-user/job-apply-project/" \
  "$HOME/hgfs-mount/auto-apply/job-apply-project/"; do
  parent="$(dirname "${candidate%/}")"
  if [[ -d "$parent" ]]; then
    DEST="$candidate"
    break
  fi
done
if [[ -z "$DEST" ]]; then
  echo "No HGFS auto-apply share found. Mount with e.g.:" >&2
  echo "  mkdir -p /tmp/hgfs-user && vmhgfs-fuse .host:/auto-apply /tmp/hgfs-user" >&2
  exit 1
fi
mkdir -p "$DEST"

# extension/test-forms/captured/ is excluded from --delete's reach: it holds real "Save Sample"
# captures written directly by a live companion-service instance, not code — this local
# checkout never has a copy of it, so a plain --delete sync would silently wipe out real
# captured data on every run (confirmed happened at least once).
rsync -a --delete --exclude 'venv' --exclude '__pycache__' --exclude 'node_modules' --exclude 'extension/test-forms/captured' --exclude 'companion-service/.portal-browser-profile' --exclude 'companion-service/.chatgpt-browser-profile' "$SRC" "$DEST"
echo "Synced $SRC -> $DEST"

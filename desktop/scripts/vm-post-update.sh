#!/bin/sh
# vm-post-update.sh - optional per-release migration hook for the VM browser
# host. vm-update.sh runs this from the NEW checkout right after the tag is
# pinned and dependencies are installed, before services restart. It receives
# the release tag as $1 (for example "v0.3.2").
#
# Use it when a release needs a one-time migration on existing VMs that a
# plain checkout + npm ci cannot do alone. Keep it idempotent: it may run
# more than once on the same machine if a retry happens. It must only touch
# this checkout and the browser host's own data dir.
#
# A non-zero exit stops the update and marks the VM failed, so only fail when
# the host truly cannot run the new release. Windows guests look for a
# vm-post-update.ps1 twin in this directory instead.
exit 0

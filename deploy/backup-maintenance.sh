#!/bin/sh
# Run only on the deployed dedicated host during an agreed maintenance window.
set -eu
exec 9>/run/lock/dukanos-backup.lock
flock -n 9
cd /opt/dukanos/current
systemctl stop dukanos.service
# Restart even after a failed backup; never swallow backup exit status.
trap 'systemctl start dukanos.service' EXIT
/usr/bin/node --env-file=/etc/dukanos/backup.env scripts/backup.mjs create

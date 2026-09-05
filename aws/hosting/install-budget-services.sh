#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET is required}"

cat >/etc/systemd/system/cirkle-mysql-backup.service <<SYSTEMD
[Unit]
Description=Cirkle local MySQL encrypted S3 backup
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
Environment=AWS_REGION=${AWS_REGION}
Environment=BACKUP_BUCKET=${BACKUP_BUCKET}
ExecStart=/usr/local/sbin/cirkle-mysql-backup
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=/srv/cirkle/shared/backups /run/lock
SYSTEMD

cat >/etc/systemd/system/cirkle-mysql-backup.timer <<'SYSTEMD'
[Unit]
Description=Daily Cirkle local MySQL backup

[Timer]
OnCalendar=*-*-* 02:30:00 UTC
RandomizedDelaySec=900
Persistent=true

[Install]
WantedBy=timers.target
SYSTEMD

systemctl daemon-reload
systemctl enable --now cirkle-mysql-backup.timer
systemctl start cirkle-mysql-backup.service
systemctl is-active cirkle-mysql-backup.timer
systemctl is-failed cirkle-mysql-backup.service && exit 1 || true

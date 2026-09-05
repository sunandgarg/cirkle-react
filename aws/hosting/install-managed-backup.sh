#!/usr/bin/env bash
set -Eeuo pipefail

: "${BACKUP_ENV_FILE:?BACKUP_ENV_FILE is required}"
[[ "$(id -u)" == "0" ]] || { echo "Run as root" >&2; exit 1; }
[[ -s "${BACKUP_ENV_FILE}" ]] || { echo "Backup environment is missing" >&2; exit 1; }

install -o root -g root -m 0600 "${BACKUP_ENV_FILE}" /etc/cirkle/backup.env

cat >/etc/systemd/system/cirkle-mysql-backup.service <<'SYSTEMD'
[Unit]
Description=Cirkle managed MySQL encrypted off-host backup
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/cirkle/backup.env
ExecStart=/usr/local/sbin/cirkle-mysql-backup
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=/run/lock /tmp
SYSTEMD

cat >/etc/systemd/system/cirkle-mysql-backup.timer <<'SYSTEMD'
[Unit]
Description=Daily Cirkle managed MySQL off-host backup

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
systemctl is-failed cirkle-mysql-backup.service && exit 1 || true
systemctl list-timers cirkle-mysql-backup.timer --no-pager

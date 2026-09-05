#!/usr/bin/env bash
set -Eeuo pipefail

: "${BACKUP_ENV_FILE:?BACKUP_ENV_FILE is required}"
[[ "$(id -u)" == "0" ]] || { echo "Run as root" >&2; exit 1; }
[[ -s "${BACKUP_ENV_FILE}" ]] || { echo "Backup environment is missing" >&2; exit 1; }
[[ -f "${BACKUP_ENV_FILE}" && ! -L "${BACKUP_ENV_FILE}" ]] || {
  echo "Backup environment must be a regular, non-symlink file" >&2
  exit 1
}
insecure_backup_env="$(find "${BACKUP_ENV_FILE}" -maxdepth 0 -perm /0077 -print)"
[[ -z "${insecure_backup_env}" ]] || {
  echo "Backup environment must not be accessible by group or other users" >&2
  exit 1
}
if systemctl is-active --quiet cirkle-mysql-backup.service 2>/dev/null; then
  echo "A database backup is already running; wait for it to finish" >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
[[ -s "${script_dir}/backup-managed-mysql.sh" ]] || {
  echo "backup-managed-mysql.sh must be alongside this installer" >&2
  exit 1
}

rollback_dir="$(mktemp -d)"
installation_succeeded=false
backup_script_existed=false
backup_env_existed=false
service_unit_existed=false
timer_unit_existed=false
timer_was_enabled=false
timer_was_active=false

if [[ -f /usr/local/sbin/cirkle-mysql-backup ]]; then
  install -o root -g root -m 0750 /usr/local/sbin/cirkle-mysql-backup "${rollback_dir}/backup-script"
  backup_script_existed=true
fi
if [[ -f /etc/cirkle/backup.env ]]; then
  install -o root -g root -m 0600 /etc/cirkle/backup.env "${rollback_dir}/backup.env"
  backup_env_existed=true
fi
if [[ -f /etc/systemd/system/cirkle-mysql-backup.service ]]; then
  install -o root -g root -m 0644 /etc/systemd/system/cirkle-mysql-backup.service "${rollback_dir}/backup.service"
  service_unit_existed=true
fi
if [[ -f /etc/systemd/system/cirkle-mysql-backup.timer ]]; then
  install -o root -g root -m 0644 /etc/systemd/system/cirkle-mysql-backup.timer "${rollback_dir}/backup.timer"
  timer_unit_existed=true
fi
systemctl is-enabled --quiet cirkle-mysql-backup.timer 2>/dev/null && timer_was_enabled=true
systemctl is-active --quiet cirkle-mysql-backup.timer 2>/dev/null && timer_was_active=true

finish() {
  local status=$?
  trap - EXIT
  if [[ "${installation_succeeded}" != true ]]; then
    set +e
    if [[ "${backup_script_existed}" == true ]]; then
      install -o root -g root -m 0750 "${rollback_dir}/backup-script" /usr/local/sbin/cirkle-mysql-backup
    else
      rm -f -- /usr/local/sbin/cirkle-mysql-backup
    fi
    if [[ "${backup_env_existed}" == true ]]; then
      install -o root -g root -m 0600 "${rollback_dir}/backup.env" /etc/cirkle/backup.env
    else
      rm -f -- /etc/cirkle/backup.env
    fi
    if [[ "${service_unit_existed}" == true ]]; then
      install -o root -g root -m 0644 "${rollback_dir}/backup.service" /etc/systemd/system/cirkle-mysql-backup.service
    else
      rm -f -- /etc/systemd/system/cirkle-mysql-backup.service
    fi
    if [[ "${timer_unit_existed}" == true ]]; then
      install -o root -g root -m 0644 "${rollback_dir}/backup.timer" /etc/systemd/system/cirkle-mysql-backup.timer
    else
      rm -f -- /etc/systemd/system/cirkle-mysql-backup.timer
    fi
    systemctl daemon-reload
    if [[ "${timer_was_enabled}" == true ]]; then
      systemctl enable cirkle-mysql-backup.timer
    else
      systemctl disable cirkle-mysql-backup.timer
    fi
    if [[ "${timer_was_active}" == true ]]; then
      systemctl start cirkle-mysql-backup.timer
    else
      systemctl stop cirkle-mysql-backup.timer
    fi
    echo "Managed-backup installation failed; the previous backup configuration was restored" >&2
  fi
  rm -rf -- "${rollback_dir}"
  exit "${status}"
}
trap finish EXIT
systemctl stop cirkle-mysql-backup.timer 2>/dev/null || true
if systemctl is-active --quiet cirkle-mysql-backup.service 2>/dev/null; then
  echo "A database backup started during installation; retry after it finishes" >&2
  exit 1
fi

install -o root -g root -m 0750 "${script_dir}/backup-managed-mysql.sh" /usr/local/sbin/cirkle-mysql-backup
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
ProtectSystem=strict
ReadWritePaths=/run/lock /tmp
UMask=0077
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
if ! systemctl start cirkle-mysql-backup.service; then
  journalctl -u cirkle-mysql-backup.service --no-pager -n 80 >&2
  exit 1
fi
systemctl is-failed --quiet cirkle-mysql-backup.service && exit 1 || true
systemctl enable --now cirkle-mysql-backup.timer
systemctl list-timers cirkle-mysql-backup.timer --no-pager
installation_succeeded=true

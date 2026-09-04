#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

env_file="${CIRKLE_ENV_FILE:-/etc/cirkle/backup.env}"
if [[ ! -r "${env_file}" ]]; then
  echo "Environment file is not readable: ${env_file}" >&2
  exit 1
fi
insecure_mode="$(find "${env_file}" -maxdepth 0 -perm /0027 -print)"
if [[ -n "${insecure_mode}" ]]; then
  echo "Backup environment must not be group-writable or accessible by other users (use mode 0640 or stricter): ${env_file}" >&2
  exit 1
fi

# The protected backup file is administrator-controlled and intentionally
# shell-compatible. Values remain shell-local and are passed only through the
# temporary MySQL client configuration below.
# shellcheck disable=SC1090
source "${env_file}"

require_value() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Required backup setting is empty: ${name}" >&2
    exit 1
  fi
}

for command_name in mysqldump gzip mktemp flock; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Required command is unavailable: ${command_name}" >&2
    exit 1
  fi
done

require_value MYSQL_BACKUP_HOST
require_value MYSQL_BACKUP_PORT
require_value MYSQL_BACKUP_DATABASE
require_value MYSQL_BACKUP_USER
require_value MYSQL_BACKUP_PASSWORD
require_value MYSQL_BACKUP_DIR

if [[ ! "${MYSQL_BACKUP_PORT}" =~ ^[0-9]+$ ]]; then
  echo "MYSQL_BACKUP_PORT must be between 1 and 65535" >&2
  exit 1
fi
backup_port_number=$((10#${MYSQL_BACKUP_PORT}))
if (( backup_port_number < 1 || backup_port_number > 65535 )); then
  echo "MYSQL_BACKUP_PORT must be between 1 and 65535" >&2
  exit 1
fi

mkdir -p -- "${MYSQL_BACKUP_DIR}"
backup_dir="$(cd "${MYSQL_BACKUP_DIR}" && pwd -P)"
if [[ "${backup_dir}" == "/" ]]; then
  echo "Refusing to use the filesystem root as a backup directory" >&2
  exit 1
fi

exec 9>"${backup_dir}/.backup.lock"
if ! flock -n 9; then
  echo "Another MySQL backup is already running for ${backup_dir}" >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_name="cirkle-${timestamp}.sql.gz"
backup_file="${backup_dir}/${backup_name}"
partial_file="${backup_file}.partial"
defaults_file="$(mktemp "${TMPDIR:-/tmp}/cirkle-mysql.XXXXXX")"

cleanup() {
  rm -f -- "${defaults_file}" "${partial_file}"
}
trap cleanup EXIT

cnf_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "${value}"
}

{
  printf '[client]\n'
  printf 'host="%s"\n' "$(cnf_escape "${MYSQL_BACKUP_HOST}")"
  printf 'port="%s"\n' "$(cnf_escape "${MYSQL_BACKUP_PORT}")"
  printf 'user="%s"\n' "$(cnf_escape "${MYSQL_BACKUP_USER}")"
  printf 'password="%s"\n' "$(cnf_escape "${MYSQL_BACKUP_PASSWORD}")"
  printf 'protocol=tcp\n'
} >"${defaults_file}"
chmod 0600 "${defaults_file}"

echo "Creating a consistent MySQL backup at ${backup_file}"
mysqldump \
  --defaults-file="${defaults_file}" \
  --no-login-paths \
  --single-transaction \
  --quick \
  --triggers \
  --hex-blob \
  --set-gtid-purged=OFF \
  --no-tablespaces \
  --default-character-set=utf8mb4 \
  --databases "${MYSQL_BACKUP_DATABASE}" \
  | gzip -9 >"${partial_file}"

gzip -t "${partial_file}"
mv -- "${partial_file}" "${backup_file}"

if command -v sha256sum >/dev/null 2>&1; then
  (
    cd "${backup_dir}"
    sha256sum "${backup_name}" >"${backup_name}.sha256"
  )
elif command -v shasum >/dev/null 2>&1; then
  (
    cd "${backup_dir}"
    shasum -a 256 "${backup_name}" >"${backup_name}.sha256"
  )
else
  echo "Neither sha256sum nor shasum is available; backup checksum was not created" >&2
  exit 1
fi

retention_days="${MYSQL_BACKUP_RETENTION_DAYS:-0}"
if [[ ! "${retention_days}" =~ ^[0-9]+$ ]]; then
  echo "MYSQL_BACKUP_RETENTION_DAYS must be a non-negative integer" >&2
  exit 1
fi
retention_number=$((10#${retention_days}))

if (( retention_number > 0 )); then
  while IFS= read -r expired_backup; do
    echo "Removing expired backup: ${expired_backup}"
    rm -f -- "${expired_backup}" "${expired_backup}.sha256"
  done < <(find "${backup_dir}" -maxdepth 1 -type f -name 'cirkle-*.sql.gz' -mtime "+${retention_number}" -print)
fi

echo "Backup complete: ${backup_file}"
echo "Checksum: ${backup_file}.sha256"

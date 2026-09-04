#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${CIRKLE_MYSQL_PORT:-3306}"
STATE_DIR="${CIRKLE_MYSQL_STATE_DIR:-${ROOT_DIR}/.local/mysql-runtime}"
DATA_DIR="${STATE_DIR}/data"
# Unix-domain sockets have a platform path-length limit. Keep only ephemeral
# runtime files under a short /tmp path while database bytes remain in .local.
RUNTIME_DIR="${CIRKLE_MYSQL_RUNTIME_DIR:-/tmp/cirkle-mysql-${PORT}}"
SOCKET_FILE="${RUNTIME_DIR}/mysql.sock"
PID_FILE="${RUNTIME_DIR}/mysql.pid"
LOG_FILE="${STATE_DIR}/mysql.log"
MYSQLD_BIN="${MYSQLD_BIN:-$(command -v mysqld || true)}"
MYSQL_BIN="${MYSQL_BIN:-$(command -v mysql || true)}"
MYSQLADMIN_BIN="${MYSQLADMIN_BIN:-$(command -v mysqladmin || true)}"
CIRKLE_DB_NAME="${MYSQL_DATABASE:-cirkle}"
CIRKLE_DB_USER="${MYSQL_USER:-cirkle}"
CIRKLE_DB_PASSWORD="${MYSQL_PASSWORD:-cirkle_local_only_change_me}"

require_mysql() {
  if [[ -z "${MYSQLD_BIN}" || -z "${MYSQL_BIN}" || -z "${MYSQLADMIN_BIN}" ]]; then
    echo "MySQL binaries were not found. Install MySQL 8.4+ or use: docker compose up -d mysql" >&2
    exit 1
  fi
}

is_running() {
  [[ -S "${SOCKET_FILE}" ]] && "${MYSQLADMIN_BIN}" --protocol=socket --socket="${SOCKET_FILE}" --user=root ping >/dev/null 2>&1
}

provision_app_database() {
  if [[ ! "${CIRKLE_DB_NAME}" =~ ^[A-Za-z0-9_]+$ ]]; then
    echo "MYSQL_DATABASE must contain only letters, digits, and underscores." >&2
    exit 1
  fi
  if [[ ! "${CIRKLE_DB_USER}" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    echo "MYSQL_USER contains unsupported characters." >&2
    exit 1
  fi
  if [[ ! "${CIRKLE_DB_PASSWORD}" =~ ^[A-Za-z0-9_.:@+-]{8,128}$ ]]; then
    echo "MYSQL_PASSWORD must be 8-128 URL-safe characters for the local helper." >&2
    exit 1
  fi
  "${MYSQL_BIN}" --protocol=socket --socket="${SOCKET_FILE}" --user=root --execute="
    CREATE DATABASE IF NOT EXISTS \`${CIRKLE_DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    CREATE USER IF NOT EXISTS '${CIRKLE_DB_USER}'@'localhost' IDENTIFIED BY '${CIRKLE_DB_PASSWORD}';
    CREATE USER IF NOT EXISTS '${CIRKLE_DB_USER}'@'127.0.0.1' IDENTIFIED BY '${CIRKLE_DB_PASSWORD}';
    ALTER USER '${CIRKLE_DB_USER}'@'localhost' IDENTIFIED BY '${CIRKLE_DB_PASSWORD}';
    ALTER USER '${CIRKLE_DB_USER}'@'127.0.0.1' IDENTIFIED BY '${CIRKLE_DB_PASSWORD}';
    GRANT ALL PRIVILEGES ON \`${CIRKLE_DB_NAME}\`.* TO '${CIRKLE_DB_USER}'@'localhost';
    GRANT ALL PRIVILEGES ON \`${CIRKLE_DB_NAME}\`.* TO '${CIRKLE_DB_USER}'@'127.0.0.1';
  "
}

initialize() {
  require_mysql
  mkdir -p "${STATE_DIR}" "${RUNTIME_DIR}"
  if [[ -d "${DATA_DIR}/mysql" ]]; then
    return
  fi
  mkdir -p "${DATA_DIR}"
  "${MYSQLD_BIN}" --no-defaults --initialize-insecure --datadir="${DATA_DIR}"
}

start() {
  initialize
  if is_running; then
    provision_app_database
    echo "Cirkle MySQL is already running on 127.0.0.1:${PORT}."
    return
  fi
  "${MYSQLD_BIN}" \
    --no-defaults \
    --datadir="${DATA_DIR}" \
    --socket="${SOCKET_FILE}" \
    --pid-file="${PID_FILE}" \
    --log-error="${LOG_FILE}" \
    --port="${PORT}" \
    --bind-address=127.0.0.1 \
    --mysqlx=0 \
    --daemonize

  for _ in {1..40}; do
    if is_running; then
      provision_app_database
      echo "Cirkle MySQL started on 127.0.0.1:${PORT}."
      return
    fi
    sleep 0.25
  done

  echo "MySQL did not become ready. Inspect ${LOG_FILE}." >&2
  exit 1
}

stop() {
  require_mysql
  if ! is_running; then
    echo "Cirkle MySQL is not running."
    return
  fi
  "${MYSQLADMIN_BIN}" --protocol=socket --socket="${SOCKET_FILE}" --user=root shutdown
  echo "Cirkle MySQL stopped. Data remains in ${DATA_DIR}."
}

status() {
  require_mysql
  if is_running; then
    echo "Cirkle MySQL is running on 127.0.0.1:${PORT}."
  else
    echo "Cirkle MySQL is stopped."
    exit 1
  fi
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *) echo "Usage: $0 {start|stop|restart|status}" >&2; exit 2 ;;
esac

#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${DB_HOST:?DB_HOST is required}"
: "${DB_MASTER_USER:?DB_MASTER_USER is required}"
: "${DB_MASTER_PASSWORD_FILE:?DB_MASTER_PASSWORD_FILE is required}"
: "${DB_APP_PASSWORD_FILE:?DB_APP_PASSWORD_FILE is required}"

[[ -s "${DB_MASTER_PASSWORD_FILE}" && -s "${DB_APP_PASSWORD_FILE}" ]] || {
  echo "Database password files must be non-empty" >&2
  exit 1
}

master_password="$(<"${DB_MASTER_PASSWORD_FILE}")"
app_password="$(<"${DB_APP_PASSWORD_FILE}")"
[[ "${app_password}" != *"'"* && "${app_password}" != *"\\"* ]] || {
  echo "Application password contains an unsupported SQL delimiter" >&2
  exit 1
}

defaults_file="$(mktemp)"
trap 'rm -f -- "${defaults_file}"' EXIT
cat >"${defaults_file}" <<EOF
[client]
host=${DB_HOST}
port=3306
user=${DB_MASTER_USER}
password=${master_password}
ssl
EOF
chmod 0600 "${defaults_file}"

mysql --defaults-file="${defaults_file}" <<SQL
CREATE DATABASE IF NOT EXISTS cirkle CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'cirkle'@'%' IDENTIFIED BY '${app_password}';
ALTER USER 'cirkle'@'%' IDENTIFIED BY '${app_password}';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES, CREATE TEMPORARY TABLES, LOCK TABLES
  ON cirkle.* TO 'cirkle'@'%';
FLUSH PRIVILEGES;
SQL

MYSQL_PWD="${app_password}" mysql --no-defaults --ssl --protocol=tcp --host="${DB_HOST}" --port=3306 --user=cirkle \
  --database=cirkle --execute='SELECT DATABASE() AS database_name, CURRENT_USER() AS authenticated_user;'

#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${DB_HOST:?DB_HOST is required}"
: "${DB_MASTER_USER:?DB_MASTER_USER is required}"
: "${DB_MASTER_PASSWORD_FILE:?DB_MASTER_PASSWORD_FILE is required}"
: "${DB_APP_PASSWORD_FILE:?DB_APP_PASSWORD_FILE is required}"
: "${DB_MIGRATION_PASSWORD_FILE:?DB_MIGRATION_PASSWORD_FILE is required}"
: "${DB_BACKUP_PASSWORD_FILE:?DB_BACKUP_PASSWORD_FILE is required}"
: "${DB_CA_FILE:?DB_CA_FILE is required}"

for protected_file in "${DB_MASTER_PASSWORD_FILE}" "${DB_APP_PASSWORD_FILE}" \
  "${DB_MIGRATION_PASSWORD_FILE}" "${DB_BACKUP_PASSWORD_FILE}" "${DB_CA_FILE}"; do
  [[ -s "${protected_file}" ]] || {
    echo "Required database credential/CA file is empty: ${protected_file}" >&2
    exit 1
  }
done

[[ "$(id -u)" == "0" ]] || {
  echo "Run as root so credential-file permissions can be verified" >&2
  exit 1
}
for password_file in "${DB_MASTER_PASSWORD_FILE}" "${DB_APP_PASSWORD_FILE}" \
  "${DB_MIGRATION_PASSWORD_FILE}" "${DB_BACKUP_PASSWORD_FILE}"; do
  [[ -f "${password_file}" && ! -L "${password_file}" ]] || {
    echo "Database password paths must be regular, non-symlink files" >&2
    exit 1
  }
  insecure_password_file="$(find "${password_file}" -maxdepth 0 -perm /0077 -print)"
  [[ -z "${insecure_password_file}" ]] || {
    echo "Database password files must not be accessible by group or other users" >&2
    exit 1
  }
done

master_password="$(<"${DB_MASTER_PASSWORD_FILE}")"
app_password="$(<"${DB_APP_PASSWORD_FILE}")"
migration_password="$(<"${DB_MIGRATION_PASSWORD_FILE}")"
backup_password="$(<"${DB_BACKUP_PASSWORD_FILE}")"
for password in "${app_password}" "${migration_password}" "${backup_password}"; do
  [[ "${password}" =~ ^[A-Za-z0-9_-]{32,128}$ ]] || {
    echo "Generated database passwords must be 32-128 URL-safe characters" >&2
    exit 1
  }
done

[[ "${app_password}" != "${migration_password}" \
  && "${app_password}" != "${backup_password}" \
  && "${migration_password}" != "${backup_password}" \
  && "${master_password}" != "${app_password}" \
  && "${master_password}" != "${migration_password}" \
  && "${master_password}" != "${backup_password}" ]] || {
  echo "Master, runtime, migration, and backup database passwords must be distinct" >&2
  exit 1
}

[[ "${DB_HOST}" =~ ^[A-Za-z0-9.-]+\.rds\.amazonaws\.com$ ]] || {
  echo "DB_HOST must be the private AWS managed-database hostname" >&2
  exit 1
}
[[ "${DB_MASTER_USER}" =~ ^[A-Za-z0-9_]{1,32}$ ]] || {
  echo "DB_MASTER_USER contains unsupported characters" >&2
  exit 1
}
grep -q -- '-----BEGIN CERTIFICATE-----' "${DB_CA_FILE}" || {
  echo "DB_CA_FILE is not a PEM CA bundle" >&2
  exit 1
}

mysql_tls=(
  mysql --no-defaults --protocol=tcp --host="${DB_HOST}" --port=3306
  --ssl --ssl-ca="${DB_CA_FILE}" --ssl-verify-server-cert
)

master_cipher="$(
  MYSQL_PWD="${master_password}" "${mysql_tls[@]}" --user="${DB_MASTER_USER}" \
    --batch --skip-column-names --execute="SHOW SESSION STATUS LIKE 'Ssl_cipher';" \
    | awk '$1 == "Ssl_cipher" { print $2 }'
)"
[[ -n "${master_cipher}" ]] || {
  echo "The master database session did not negotiate verified TLS" >&2
  exit 1
}
global_secure_transport="$(
  MYSQL_PWD="${master_password}" "${mysql_tls[@]}" --user="${DB_MASTER_USER}" \
    --batch --skip-column-names --execute="SELECT @@GLOBAL.require_secure_transport;"
)"

MYSQL_PWD="${master_password}" "${mysql_tls[@]}" --user="${DB_MASTER_USER}" <<SQL
CREATE DATABASE IF NOT EXISTS cirkle CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'cirkle_app'@'%' IDENTIFIED BY '${app_password}' REQUIRE SSL;
ALTER USER 'cirkle_app'@'%' IDENTIFIED BY '${app_password}' REQUIRE SSL;
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'cirkle_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON cirkle.* TO 'cirkle_app'@'%';

CREATE USER IF NOT EXISTS 'cirkle_migrate'@'%' IDENTIFIED BY '${migration_password}' REQUIRE SSL;
ALTER USER 'cirkle_migrate'@'%' IDENTIFIED BY '${migration_password}' REQUIRE SSL;
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'cirkle_migrate'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES,
  CREATE TEMPORARY TABLES, LOCK TABLES ON cirkle.* TO 'cirkle_migrate'@'%';

CREATE USER IF NOT EXISTS 'cirkle_backup'@'%' IDENTIFIED BY '${backup_password}' REQUIRE SSL;
ALTER USER 'cirkle_backup'@'%' IDENTIFIED BY '${backup_password}' REQUIRE SSL;
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'cirkle_backup'@'%';
GRANT SELECT, SHOW VIEW, TRIGGER ON cirkle.* TO 'cirkle_backup'@'%';
FLUSH PRIVILEGES;
SQL

for account in app migration backup; do
  case "${account}" in
    app) username="cirkle_app"; password="${app_password}" ;;
    migration) username="cirkle_migrate"; password="${migration_password}" ;;
    backup) username="cirkle_backup"; password="${backup_password}" ;;
  esac
  cipher="$(
    MYSQL_PWD="${password}" "${mysql_tls[@]}" --user="${username}" --database=cirkle \
      --batch --skip-column-names --execute="SHOW SESSION STATUS LIKE 'Ssl_cipher';" \
      | awk '$1 == "Ssl_cipher" { print $2 }'
  )"
  [[ -n "${cipher}" ]] || {
    echo "${username} did not negotiate verified TLS" >&2
    exit 1
  }
  MYSQL_PWD="${password}" "${mysql_tls[@]}" --user="${username}" --database=cirkle \
    --execute="SELECT DATABASE() AS database_name, CURRENT_USER() AS authenticated_user;"
done

echo "Provisioned separate TLS-only runtime, migration, and backup database identities"
if [[ "${global_secure_transport}" != "1" ]]; then
  echo "NOTICE: each new user requires SSL, but global require_secure_transport is not enabled; schedule the documented managed-database parameter reboot after all clients use TLS" >&2
fi

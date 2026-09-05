#!/usr/bin/env bash
set -euo pipefail

sql_file="$(mktemp)"
local_counts="$(mktemp)"
rds_counts="$(mktemp)"
trap 'rm -f "$sql_file" "$local_counts" "$rds_counts"' EXIT

cat >"$sql_file" <<'SQL'
SET SESSION group_concat_max_len = 1000000;
SELECT GROUP_CONCAT(
  CONCAT('SELECT ', QUOTE(table_name), ' AS table_name, COUNT(*) AS row_count FROM `cirkle`.`', REPLACE(table_name, '`', '``'), '`')
  ORDER BY table_name SEPARATOR ' UNION ALL '
) INTO @count_sql
FROM information_schema.tables
WHERE table_schema = 'cirkle' AND table_type = 'BASE TABLE';
PREPARE count_statement FROM @count_sql;
EXECUTE count_statement;
DEALLOCATE PREPARE count_statement;
SQL

docker exec -i cirkle-mysql mysql --defaults-file=/run/secrets/root-client.cnf --batch --skip-column-names \
  <"$sql_file" | sort >"$local_counts"
docker run --rm -i --network host \
  -v /etc/cirkle/mysql-secrets/rds-client.cnf:/run/rds-client.cnf:ro \
  -v "$sql_file":/run/counts.sql:ro \
  mysql:8.4 mysql --defaults-file=/run/rds-client.cnf --no-login-paths --batch --skip-column-names \
  <"$sql_file" | sort >"$rds_counts"

diff -u "$rds_counts" "$local_counts"
printf 'verified_tables=%s\n' "$(wc -l <"$local_counts" | tr -d ' ')"
sha256sum "$local_counts" | awk '{print "row_count_manifest_sha256=" $1}'

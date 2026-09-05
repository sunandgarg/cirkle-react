#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${APP_SECRET_ID:?APP_SECRET_ID is required}"
: "${DATABASE_SECRET_ID:?DATABASE_SECRET_ID is required}"
: "${DATABASE_ENDPOINT:?DATABASE_ENDPOINT is required}"

mysql_image="mysql:8.4"
backup_root="/srv/cirkle/shared/backups"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
cutover_dump="${backup_root}/rds-cutover-${timestamp}.sql.gz"

dnf install -y docker jq gzip
systemctl enable --now docker

# A small swap file absorbs short build/database memory spikes on the 2 GiB
# budget host. It is not a substitute for database backups.
if ! swapon --show=NAME --noheadings | grep -q .; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l 2G /swapfile
    chmod 0600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || printf '/swapfile none swap sw 0 0\n' >>/etc/fstab
fi

install -d -o 999 -g 999 -m 0750 /srv/cirkle/mysql-data
install -d -o root -g root -m 0700 /etc/cirkle/mysql-secrets
install -d -o root -g root -m 0755 /etc/cirkle/mysql-conf.d
install -d -o root -g cirkle -m 0750 "$backup_root"

app_config="$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$APP_SECRET_ID" --query SecretString --output text)"
rds_config="$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$DATABASE_SECRET_ID" --query SecretString --output text)"
local_password="$(jq -er '.LOCAL_MYSQL_PASSWORD' <<<"$app_config")"
local_root_password="$(jq -er '.LOCAL_MYSQL_ROOT_PASSWORD' <<<"$app_config")"
rds_user="$(jq -er '.username' <<<"$rds_config")"
rds_password="$(jq -er '.password' <<<"$rds_config")"
rds_port="$(jq -er '.port // 3306' <<<"$rds_config")"

umask 0077
printf '%s' "$local_password" >/etc/cirkle/mysql-secrets/app-password
printf '%s' "$local_root_password" >/etc/cirkle/mysql-secrets/root-password
printf '[client]\nuser=root\npassword=%s\nhost=127.0.0.1\nport=3306\n' "$local_root_password" >/etc/cirkle/mysql-secrets/root-client.cnf
printf '[client]\nuser=%s\npassword=%s\nhost=%s\nport=%s\n' "$rds_user" "$rds_password" "$DATABASE_ENDPOINT" "$rds_port" >/etc/cirkle/mysql-secrets/rds-client.cnf
chmod 0400 /etc/cirkle/mysql-secrets/*

cat >/etc/cirkle/mysql-conf.d/cirkle.cnf <<'MYSQL'
[mysqld]
character-set-server=utf8mb4
collation-server=utf8mb4_0900_ai_ci
max_connections=80
innodb_buffer_pool_size=268435456
innodb_redo_log_capacity=134217728
performance_schema=OFF
skip_name_resolve=ON
MYSQL

docker pull "$mysql_image"
if ! docker container inspect cirkle-mysql >/dev/null 2>&1; then
  docker run -d \
    --name cirkle-mysql \
    --restart unless-stopped \
    --memory 768m \
    --pids-limit 300 \
    --log-driver json-file \
    --log-opt max-size=10m \
    --log-opt max-file=3 \
    -p 127.0.0.1:3306:3306 \
    -e MYSQL_ROOT_PASSWORD_FILE=/run/secrets/root-password \
    -e MYSQL_DATABASE=cirkle \
    -e MYSQL_USER=cirkle \
    -e MYSQL_PASSWORD_FILE=/run/secrets/app-password \
    -v /srv/cirkle/mysql-data:/var/lib/mysql \
    -v /etc/cirkle/mysql-secrets:/run/secrets:ro \
    -v /etc/cirkle/mysql-conf.d:/etc/mysql/conf.d:ro \
    "$mysql_image"
fi

for attempt in $(seq 1 90); do
  if docker exec cirkle-mysql mysqladmin --defaults-file=/run/secrets/root-client.cnf ping --silent; then
    break
  fi
  if [[ "$attempt" == 90 ]]; then
    docker logs --tail 100 cirkle-mysql
    exit 1
  fi
  sleep 2
done

# Freeze this new copy only while taking the final consistent RDS dump. The
# source Supabase project and existing sites are not touched.
systemctl stop cirkle-api
trap 'systemctl start cirkle-api >/dev/null 2>&1 || true' EXIT

docker run --rm --network host \
  -v /etc/cirkle/mysql-secrets/rds-client.cnf:/run/rds-client.cnf:ro \
  "$mysql_image" \
  mysqldump --defaults-file=/run/rds-client.cnf --no-login-paths \
    --single-transaction --hex-blob --set-gtid-purged=OFF \
    --skip-routines --skip-events --triggers --databases cirkle \
  | gzip -9 >"$cutover_dump"
chmod 0640 "$cutover_dump"

gzip -dc "$cutover_dump" \
  | docker exec -i cirkle-mysql mysql --defaults-file=/run/secrets/root-client.cnf

# The application process receives only the application DB URL, never the
# local MySQL root credential.
jq -r 'del(.LOCAL_MYSQL_PASSWORD,.LOCAL_MYSQL_ROOT_PASSWORD) | to_entries[] | "\(.key)=\(.value | tostring)"' \
  <<<"$app_config" >/etc/cirkle/api.env
chown root:cirkle /etc/cirkle/api.env
chmod 0640 /etc/cirkle/api.env

systemctl start cirkle-api
for attempt in $(seq 1 60); do
  if curl --fail --silent http://127.0.0.1:3001/readyz >/tmp/cirkle-local-ready.json; then
    break
  fi
  if [[ "$attempt" == 60 ]]; then
    journalctl -u cirkle-api --no-pager -n 100
    exit 1
  fi
  sleep 2
done
trap - EXIT

docker exec cirkle-mysql mysql --defaults-file=/run/secrets/root-client.cnf --batch --skip-column-names \
  -e "SELECT CONCAT('users=',COUNT(*)) FROM cirkle.users; SELECT CONCAT('profiles=',COUNT(*)) FROM cirkle.profiles; SELECT CONCAT('posts=',COUNT(*)) FROM cirkle.posts; SELECT CONCAT('legacy_records=',COUNT(*)) FROM cirkle.legacy_records; SELECT CONCAT('file_objects=',COUNT(*)) FROM cirkle.file_objects;"
cat /tmp/cirkle-local-ready.json
printf '\ncutover_dump=%s\n' "$cutover_dump"

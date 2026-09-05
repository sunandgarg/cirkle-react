#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET is required}"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$(mktemp --tmpdir=/srv/cirkle/shared/backups "mysql-${timestamp}-XXXXXX.sql.gz")"
trap 'rm -f "$backup"' EXIT

flock -n /run/lock/cirkle-mysql-backup.lock bash -c '
  set -euo pipefail
  docker exec cirkle-mysql mysqldump --defaults-file=/run/secrets/root-client.cnf \
    --single-transaction --hex-blob --set-gtid-purged=OFF \
    --skip-routines --skip-events --triggers --databases cirkle \
    | gzip -9 >"$1"
  test -s "$1"
  gzip -t "$1"
  aws s3 cp "$1" "s3://$2/backups/mysql/$(basename "$1")" \
    --region "$3" --only-show-errors --sse AES256
' _ "$backup" "$BACKUP_BUCKET" "$AWS_REGION"

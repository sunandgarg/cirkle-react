#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"
: "${AWS_REGION:?AWS_REGION is required}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET is required}"

work_dir="$(mktemp -d)"
trap 'rm -rf -- "${work_dir}"' EXIT
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump_file="${work_dir}/cirkle-${timestamp}.sql.gz"

flock -n /run/lock/cirkle-mysql-backup.lock bash -c '
  set -Eeuo pipefail
  url="$1"
  output="$2"
  bucket="$3"
  region="$4"
  node --input-type=module --eval '\''
    const value = new URL(process.argv[1]);
    const fields = [value.hostname, value.port || "3306", decodeURIComponent(value.username), decodeURIComponent(value.password), value.pathname.slice(1)];
    process.stdout.write(fields.map((entry) => Buffer.from(entry).toString("base64")).join("\n"));
  '\'' "$url" >"${output}.connection"
  mapfile -t encoded <"${output}.connection"
  host="$(printf %s "${encoded[0]}" | base64 -d)"
  port="$(printf %s "${encoded[1]}" | base64 -d)"
  user="$(printf %s "${encoded[2]}" | base64 -d)"
  password="$(printf %s "${encoded[3]}" | base64 -d)"
  database="$(printf %s "${encoded[4]}" | base64 -d)"
  MYSQL_PWD="$password" mariadb-dump --no-defaults --ssl --protocol=tcp --host="$host" --port="$port" --user="$user" \
    --single-transaction --hex-blob --skip-lock-tables --skip-routines --skip-events --triggers --databases "$database" \
    | gzip -9 >"$output"
  test -s "$output"
  gzip -t "$output"
  aws s3 cp "$output" "s3://${bucket}/backups/mysql/$(basename "$output")" --region "$region" --only-show-errors --sse AES256
' _ "${DATABASE_URL}" "${dump_file}" "${BACKUP_BUCKET}" "${AWS_REGION}"

echo "Encrypted off-host backup uploaded: $(basename "${dump_file}")"

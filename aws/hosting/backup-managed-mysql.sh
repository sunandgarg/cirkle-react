#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is required}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"
: "${AWS_REGION:?AWS_REGION is required}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET is required}"
: "${DATABASE_CA_FILE:?DATABASE_CA_FILE is required}"

[[ -s "${DATABASE_CA_FILE}" ]] || {
  echo "DATABASE_CA_FILE does not contain the trusted database CA bundle" >&2
  exit 1
}
grep -q -- '-----BEGIN CERTIFICATE-----' "${DATABASE_CA_FILE}" || {
  echo "DATABASE_CA_FILE is not a PEM CA bundle" >&2
  exit 1
}
[[ "${AWS_REGION}" =~ ^[a-z]{2}-[a-z]+-[0-9]$ ]] || {
  echo "AWS_REGION is invalid" >&2
  exit 1
}
[[ "${BACKUP_BUCKET}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || {
  echo "BACKUP_BUCKET is invalid" >&2
  exit 1
}

work_dir="$(mktemp -d)"
trap 'rm -rf -- "${work_dir}"' EXIT
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump_file="${work_dir}/cirkle-${timestamp}.sql.gz"

flock -n /run/lock/cirkle-mysql-backup.lock bash -c '
  set -Eeuo pipefail
  : "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is required}"
  output="$1"
  bucket="$2"
  region="$3"
  ca_file="$4"
  node --input-type=module --eval '\''
    import { isAbsolute } from "node:path";
    const raw = process.env.BACKUP_DATABASE_URL;
    const [caFile] = process.argv.slice(1);
    let value;
    try { value = new URL(raw); } catch { console.error("BACKUP_DATABASE_URL must be a valid URL"); process.exit(1); }
    const sslCert = value.searchParams.getAll("sslcert");
    const sslAccept = value.searchParams.getAll("sslaccept");
    const valid = value.protocol === "mysql:"
      && decodeURIComponent(value.username) === "cirkle_backup"
      && Boolean(value.password)
      && /^[A-Za-z0-9.-]+\.rds\.amazonaws\.com$/i.test(value.hostname)
      && (value.port || "3306") === "3306"
      && value.pathname === "/cirkle"
      && !value.hash
      && sslCert.length === 1
      && isAbsolute(sslCert[0])
      && sslCert[0] === caFile
      && sslAccept.length === 1
      && sslAccept[0].toLowerCase() === "strict";
    if (!valid) {
      console.error("BACKUP_DATABASE_URL must use cirkle_backup on the AWS managed cirkle database with sslcert=<DATABASE_CA_FILE> and sslaccept=strict");
      process.exit(1);
    }
    const fields = [value.hostname, value.port || "3306", decodeURIComponent(value.username), decodeURIComponent(value.password), value.pathname.slice(1)];
    process.stdout.write(fields.map((entry) => Buffer.from(entry).toString("base64")).join("\n"));
  '\'' "$ca_file" >"${output}.connection"
  mapfile -t encoded <"${output}.connection"
  host="$(printf %s "${encoded[0]}" | base64 -d)"
  port="$(printf %s "${encoded[1]}" | base64 -d)"
  user="$(printf %s "${encoded[2]}" | base64 -d)"
  password="$(printf %s "${encoded[3]}" | base64 -d)"
  database="$(printf %s "${encoded[4]}" | base64 -d)"
  MYSQL_PWD="$password" mariadb-dump --no-defaults --ssl --ssl-ca="$ca_file" --ssl-verify-server-cert \
    --protocol=tcp --host="$host" --port="$port" --user="$user" \
    --single-transaction --hex-blob --skip-lock-tables --no-tablespaces --skip-routines --skip-events --triggers --databases "$database" \
    | gzip -9 >"$output"
  test -s "$output"
  gzip -t "$output"
  read -r checksum _ < <(sha256sum "$output")
  object_key="backups/mysql/$(basename "$output")"
  aws s3 cp "$output" "s3://${bucket}/${object_key}" --region "$region" --only-show-errors --sse AES256 \
    --checksum-algorithm SHA256 --metadata "sha256=${checksum}"
  head="$(aws s3api head-object --bucket "$bucket" --key "$object_key" --checksum-mode ENABLED --region "$region" --output json)"
  node --input-type=module --eval '\''
    const [raw, expectedHash] = process.argv.slice(1);
    const head = JSON.parse(raw);
    if (head.ServerSideEncryption !== "AES256" || !(head.ContentLength > 0) || !head.ChecksumSHA256
      || head.Metadata?.sha256 !== expectedHash) {
      console.error("Uploaded backup failed encryption, size, or checksum-metadata verification");
      process.exit(1);
    }
  '\'' "$head" "$checksum"
' _ "${dump_file}" "${BACKUP_BUCKET}" "${AWS_REGION}" "${DATABASE_CA_FILE}"

echo "Encrypted off-host backup uploaded: $(basename "${dump_file}")"

#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

archive="${1:-/tmp/cirkle-react-source.tar.gz}"
environment_file="${2:-/tmp/cirkle-react-api.env}"
migration_environment_file="${3:-/etc/cirkle/migration.env}"
backup_environment_file="/etc/cirkle/backup.env"
release_id="${RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
release_dir="/srv/cirkle/releases/${release_id}"
runtime_environment_file="/etc/cirkle/api.env"

[[ "$(id -u)" == "0" ]] || { echo "Run as root" >&2; exit 1; }
[[ -f "${archive}" && -s "${archive}" ]] || { echo "Release archive is missing" >&2; exit 1; }
[[ -f "${environment_file}" && -s "${environment_file}" ]] || { echo "Environment file is missing" >&2; exit 1; }
[[ -f "${migration_environment_file}" && -s "${migration_environment_file}" ]] || { echo "Migration environment file is missing" >&2; exit 1; }
[[ -f "${backup_environment_file}" && -s "${backup_environment_file}" ]] || { echo "Managed-backup environment file is missing" >&2; exit 1; }
[[ "${release_id}" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Invalid RELEASE_ID" >&2; exit 1; }
[[ ! -e "${release_dir}" ]] || { echo "Release already exists; choose a new RELEASE_ID" >&2; exit 1; }

for secret_environment_file in "${environment_file}" "${migration_environment_file}" "${backup_environment_file}"; do
  [[ -f "${secret_environment_file}" && ! -L "${secret_environment_file}" ]] || {
    echo "Protected environment paths must be regular, non-symlink files" >&2
    exit 1
  }
  insecure_environment_file="$(find "${secret_environment_file}" -maxdepth 0 -perm /0077 -print)"
  [[ -z "${insecure_environment_file}" ]] || {
    echo "Protected environment files must not be accessible by group or other users before installation" >&2
    exit 1
  }
done
[[ "$(stat -c %u "${migration_environment_file}")" == "0" \
  && "$(stat -c %g "${migration_environment_file}")" == "0" \
  && "$(stat -c %a "${migration_environment_file}")" == "600" ]] || {
  echo "Migration environment must be owned by root:root with mode 0600" >&2
  exit 1
}
[[ "$(stat -c %u "${backup_environment_file}")" == "0" \
  && "$(stat -c %g "${backup_environment_file}")" == "0" \
  && "$(stat -c %a "${backup_environment_file}")" == "600" ]] || {
  echo "Managed-backup environment must be owned by root:root with mode 0600" >&2
  exit 1
}

validate_database_url() {
  local env_file="$1"
  local variable_name="$2"
  local expected_user="$3"
  env -i PATH="${PATH}" node --env-file="${env_file}" --input-type=module --eval '
    import { accessSync, constants } from "node:fs";
    import { isAbsolute } from "node:path";
    const [name, expectedUser] = process.argv.slice(1);
    const raw = process.env[name];
    let value;
    try { value = new URL(raw); } catch {
      console.error(`${name} must be a valid MySQL URL`);
      process.exit(1);
    }
    let username;
    try { username = decodeURIComponent(value.username); } catch { username = ""; }
    const sslCert = value.searchParams.getAll("sslcert");
    const sslAccept = value.searchParams.getAll("sslaccept");
    const valid = value.protocol === "mysql:"
      && username === expectedUser
      && Boolean(value.password)
      && /^[A-Za-z0-9.-]+\.rds\.amazonaws\.com$/i.test(value.hostname)
      && (value.port || "3306") === "3306"
      && value.pathname === "/cirkle"
      && !value.hash
      && sslCert.length === 1
      && isAbsolute(sslCert[0])
      && sslAccept.length === 1
      && sslAccept[0].toLowerCase() === "strict";
    if (!valid) {
      console.error(`${name} must use ${expectedUser} on the AWS managed cirkle database with an absolute sslcert and sslaccept=strict`);
      process.exit(1);
    }
    try { accessSync(sslCert[0], constants.R_OK); } catch {
      console.error(`${name} references an unreadable database CA file`);
      process.exit(1);
    }
    process.stdout.write(`${value.hostname}\n${sslCert[0]}`);
  ' "${variable_name}" "${expected_user}"
}

runtime_db_info="$(validate_database_url "${environment_file}" DATABASE_URL cirkle_app)"
migration_db_info="$(validate_database_url "${migration_environment_file}" MIGRATION_DATABASE_URL cirkle_migrate)"
backup_db_info="$(validate_database_url "${backup_environment_file}" BACKUP_DATABASE_URL cirkle_backup)"
[[ "${runtime_db_info}" == "${migration_db_info}" && "${runtime_db_info}" == "${backup_db_info}" ]] || {
  echo "Runtime, migration, and backup URLs must use the same managed database and CA bundle" >&2
  exit 1
}
database_ca_file="${runtime_db_info#*$'\n'}"
sudo -H -u cirkle test -r "${database_ca_file}" || {
  echo "The cirkle service account cannot read the database CA bundle" >&2
  exit 1
}

migration_database_url="$(
  env -i PATH="${PATH}" node --env-file="${migration_environment_file}" --input-type=module --eval '
    process.stdout.write(process.env.MIGRATION_DATABASE_URL ?? "");
  '
)"
[[ -n "${migration_database_url}" ]] || { echo "MIGRATION_DATABASE_URL is required" >&2; exit 1; }

install -d -o root -g cirkle -m 0750 /run/cirkle
staged_environment_file="$(mktemp /etc/cirkle/api.env.next.XXXXXX)"
rollback_environment_file="$(mktemp /etc/cirkle/api.env.rollback.XXXXXX)"
migration_runtime_environment_file="$(mktemp /run/cirkle/migration.XXXXXX.env)"
ready_file="$(mktemp /tmp/cirkle-ready.XXXXXX.json)"
cleanup() {
  rm -f -- "${staged_environment_file}" "${rollback_environment_file}" \
    "${migration_runtime_environment_file}" "${ready_file}"
}
trap cleanup EXIT
install -o root -g cirkle -m 0640 "${environment_file}" "${staged_environment_file}"
printf 'DATABASE_URL=%q\n' "${migration_database_url}" >"${migration_runtime_environment_file}"
chown root:cirkle "${migration_runtime_environment_file}"
chmod 0640 "${migration_runtime_environment_file}"
unset migration_database_url

install -d -o cirkle -g cirkle -m 0750 "${release_dir}"
tar --warning=no-unknown-keyword -xzf "${archive}" -C "${release_dir}"
chown -R cirkle:cirkle "${release_dir}"
[[ -x /usr/local/sbin/cirkle-mysql-backup \
  && -f "${release_dir}/aws/hosting/backup-managed-mysql.sh" \
  && "$(sha256sum /usr/local/sbin/cirkle-mysql-backup | cut -d ' ' -f 1)" == "$(sha256sum "${release_dir}/aws/hosting/backup-managed-mysql.sh" | cut -d ' ' -f 1)" ]] || {
  echo "Install this release's managed-backup script before deploying" >&2
  exit 1
}

sudo -H -u cirkle bash -lc "cd '${release_dir}' && export CI=true DATABASE_URL='mysql://build:build@127.0.0.1:3306/cirkle_build'; pnpm install --frozen-lockfile --prod=false && pnpm db:validate && pnpm db:generate && pnpm build:api"
sudo -H -u cirkle bash -lc "cd '${release_dir}' && node --env-file='${staged_environment_file}' --input-type=module --eval 'await import(\"./server/dist/config.js\");'"

systemctl is-enabled --quiet cirkle-mysql-backup.timer || {
  echo "The managed-MySQL backup timer must be installed before deployment" >&2
  exit 1
}
if ! systemctl start cirkle-mysql-backup.service; then
  journalctl -u cirkle-mysql-backup.service --no-pager -n 80 >&2
  echo "The mandatory pre-migration backup failed" >&2
  exit 1
fi
systemctl is-failed --quiet cirkle-mysql-backup.service && {
  echo "The mandatory pre-migration backup failed" >&2
  exit 1
}

sudo -H -u cirkle bash -lc "set -a; source '${migration_runtime_environment_file}'; set +a; cd '${release_dir}'; pnpm db:migrate:deploy"
rm -f -- "${migration_runtime_environment_file}"

sudo -H -u cirkle bash -lc "cd '${release_dir}' && node --env-file='${staged_environment_file}' --input-type=module --eval 'const { createApp } = await import(\"./server/dist/app.js\"); const { prisma } = await import(\"./server/dist/lib/prisma.js\"); const { probeStorageRoot } = await import(\"./server/dist/routes/health.js\"); createApp(); try { await Promise.all([prisma.\$queryRawUnsafe(\"SELECT 1\"), probeStorageRoot()]); } finally { await prisma.\$disconnect(); }'"

previous=""
if [[ -L /srv/cirkle/current ]]; then previous="$(readlink -f /srv/cirkle/current)"; fi
had_previous_environment=false
if [[ -f "${runtime_environment_file}" ]]; then
  install -o root -g cirkle -m 0640 "${runtime_environment_file}" "${rollback_environment_file}"
  had_previous_environment=true
fi

mv -Tf "${staged_environment_file}" "${runtime_environment_file}"
ln -sfn "${release_dir}" /srv/cirkle/current.next
mv -Tf /srv/cirkle/current.next /srv/cirkle/current

systemctl daemon-reload
systemctl enable --now cirkle-api
systemctl restart cirkle-api

ready=false
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 3 http://127.0.0.1:3001/readyz >"${ready_file}"; then
    ready=true
    break
  fi
  sleep 2
done
if [[ "${ready}" != true ]]; then
  journalctl -u cirkle-api --no-pager -n 120 >&2
  if [[ -n "${previous}" && -d "${previous}" ]]; then
    ln -sfn "${previous}" /srv/cirkle/current.next
    mv -Tf /srv/cirkle/current.next /srv/cirkle/current
  fi
  if [[ "${had_previous_environment}" == true ]]; then
    mv -Tf "${rollback_environment_file}" "${runtime_environment_file}"
  fi
  if [[ -n "${previous}" && -d "${previous}" && "${had_previous_environment}" == true ]]; then
    systemctl restart cirkle-api
    rollback_ready=false
    for attempt in $(seq 1 15); do
      if curl --fail --silent --max-time 3 http://127.0.0.1:3001/readyz >/dev/null; then
        rollback_ready=true
        break
      fi
      sleep 2
    done
    [[ "${rollback_ready}" == true ]] || echo "CRITICAL: the previous API release did not recover" >&2
  else
    systemctl stop cirkle-api
    if [[ "${had_previous_environment}" != true ]]; then
      rm -f -- "${runtime_environment_file}"
    fi
  fi
  exit 1
fi

cat "${ready_file}"
echo
echo "Release active: ${release_dir}"

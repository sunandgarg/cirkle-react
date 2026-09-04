#!/usr/bin/env bash
set -Eeuo pipefail

umask 027

app_root="${CIRKLE_APP_ROOT:-/srv/cirkle}"
env_file="${CIRKLE_ENV_FILE:-/etc/cirkle/api.env}"
health_url="${CIRKLE_READY_URL:-http://127.0.0.1:3001/readyz}"

fail() {
  echo "Rollback stopped: $*" >&2
  exit 1
}

[[ "${app_root}" == /* && "${app_root}" != "/" ]] || fail "CIRKLE_APP_ROOT must be a non-root absolute path"
[[ -r "${env_file}" ]] || fail "environment file is not readable: ${env_file}"
for command_name in curl flock pm2 readlink; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "required command is unavailable: ${command_name}"
done

releases_dir="${app_root}/releases"
current_link="${app_root}/current"
previous_link="${app_root}/previous"
[[ -d "${releases_dir}" ]] || fail "release directory does not exist: ${releases_dir}"
[[ -L "${current_link}" ]] || fail "current release symlink does not exist"

exec 9>"${app_root}/.deploy.lock"
flock -n 9 || fail "another deploy or rollback is already running"

current_release="$(readlink -f "${current_link}")"
if [[ -n "${1:-}" ]]; then
  [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] || fail "release must be a basename from ${releases_dir}"
  [[ -d "${releases_dir}/$1" ]] || fail "release does not exist: $1"
  target_release="$(readlink -f "${releases_dir}/$1")"
else
  [[ -L "${previous_link}" ]] || fail "no previous release is recorded; pass an explicit release basename"
  target_release="$(readlink -f "${previous_link}")"
fi

[[ "${current_release}" == "${releases_dir}/"* ]] || fail "current symlink points outside ${releases_dir}"
[[ "${target_release}" == "${releases_dir}/"* ]] || fail "target release points outside ${releases_dir}"
[[ "${target_release}" != "${current_release}" ]] || fail "target release is already active"
[[ -f "${target_release}/ecosystem.config.cjs" ]] || fail "target has no PM2 configuration"
[[ -f "${target_release}/server/dist/index.js" ]] || fail "target has no built server entrypoint"

atomic_link() {
  local target="$1"
  local link="$2"
  local temporary="${link}.tmp.$$"
  rm -f -- "${temporary}"
  ln -s "${target}" "${temporary}"
  mv -Tf -- "${temporary}" "${link}"
}

reload_release() {
  local target="$1"
  CIRKLE_ENV_FILE="${env_file}" CIRKLE_LOG_DIR="${app_root}/shared/logs" pm2 startOrReload "${target}/ecosystem.config.cjs" --env production --update-env
}

switched=false
on_error() {
  local line="$1"
  trap - ERR
  set +e
  echo "Rollback failed at line ${line}; restoring ${current_release}" >&2
  if [[ "${switched}" == true ]]; then
    atomic_link "${current_release}" "${current_link}"
    reload_release "${current_release}"
  fi
  exit 1
}
trap 'on_error "$LINENO"' ERR

echo "Switching application from ${current_release} to ${target_release}"
atomic_link "${target_release}" "${current_link}"
switched=true
reload_release "${target_release}"

ready=false
for attempt in {1..30}; do
  if curl --fail --silent --show-error --max-time 3 "${health_url}" >/dev/null; then
    ready=true
    break
  fi
  echo "Readiness check ${attempt}/30 has not passed yet"
  sleep 2
done
if [[ "${ready}" != true ]]; then
  echo "Rollback release did not pass ${health_url}" >&2
  on_error "${LINENO}"
fi

atomic_link "${current_release}" "${previous_link}"
pm2 save
trap - ERR

echo "Rollback complete: ${target_release}"
echo "Database migrations were not reversed. Confirm schema compatibility before and after every rollback."

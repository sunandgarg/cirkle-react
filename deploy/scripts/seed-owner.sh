#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

api_env_file="${CIRKLE_ENV_FILE:-/etc/cirkle/api.env}"
bootstrap_env_file="${CIRKLE_BOOTSTRAP_ENV_FILE:-/etc/cirkle/bootstrap.env}"
app_root="${CIRKLE_APP_ROOT:-/srv/cirkle}"
current_link="${app_root}/current"

fail() {
  echo "Owner seed stopped: $*" >&2
  exit 1
}

for protected_env_file in "${api_env_file}" "${bootstrap_env_file}"; do
  [[ -r "${protected_env_file}" ]] || fail "environment file is not readable: ${protected_env_file}"
  insecure_mode="$(find "${protected_env_file}" -maxdepth 0 -perm /0027 -print)"
  [[ -z "${insecure_mode}" ]] || fail "${protected_env_file} must use mode 0640 or stricter"
done

pnpm_bin="$(command -v pnpm)" || fail "pnpm is unavailable"

[[ -L "${current_link}" ]] || fail "active release symlink is missing: ${current_link}"
release_dir="$(readlink -f "${current_link}")"
[[ "${release_dir}" == "${app_root}/releases/"* ]] || fail "active release points outside ${app_root}/releases"

# These trusted files are shell-compatible, but only the database URL and
# one-time seed values are exported to the seed process. Provider/JWT secrets
# never enter the child environment.
# shellcheck disable=SC1090
source "${api_env_file}"
# shellcheck disable=SC1090
source "${bootstrap_env_file}"

[[ -n "${DATABASE_URL:-}" ]] || fail "DATABASE_URL is empty"
[[ -n "${DEFAULT_COMMUNITY_ID:-}" ]] || fail "DEFAULT_COMMUNITY_ID is empty"
[[ -n "${SEED_ADMIN_EMAIL:-}" ]] || fail "SEED_ADMIN_EMAIL is empty"
[[ -n "${SEED_ADMIN_PASSWORD:-}" ]] || fail "SEED_ADMIN_PASSWORD is empty"

cd "${release_dir}"
env -i \
PATH="${PATH}" \
HOME="${HOME}" \
DATABASE_URL="${DATABASE_URL}" \
DEFAULT_COMMUNITY_ID="${DEFAULT_COMMUNITY_ID}" \
SEED_ADMIN_EMAIL="${SEED_ADMIN_EMAIL}" \
SEED_ADMIN_PASSWORD="${SEED_ADMIN_PASSWORD}" \
SEED_ADMIN_NAME="${SEED_ADMIN_NAME:-}" \
SEED_ADMIN_IIT="${SEED_ADMIN_IIT:-}" \
SEED_ADMIN_DEGREE="${SEED_ADMIN_DEGREE:-}" \
SEED_ADMIN_SPECIALISATION="${SEED_ADMIN_SPECIALISATION:-}" \
SEED_ADMIN_PASSING_YEAR="${SEED_ADMIN_PASSING_YEAR:-}" \
SEED_ADMIN_PHONE_COUNTRY_CODE="${SEED_ADMIN_PHONE_COUNTRY_CODE:-}" \
SEED_ADMIN_PHONE_NUMBER="${SEED_ADMIN_PHONE_NUMBER:-}" \
"${pnpm_bin}" db:seed

echo "Owner seed completed. Securely delete ${bootstrap_env_file} now."

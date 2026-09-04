#!/usr/bin/env bash
set -Eeuo pipefail

umask 027

app_root="${CIRKLE_APP_ROOT:-/srv/cirkle}"
env_file="${CIRKLE_ENV_FILE:-/etc/cirkle/api.env}"
ops_env_file="${CIRKLE_OPS_ENV_FILE:-/etc/cirkle/backup.env}"
health_url="${CIRKLE_READY_URL:-http://127.0.0.1:3001/readyz}"
run_server_tests="${CIRKLE_RUN_SERVER_TESTS:-true}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source_root="$(cd "${script_dir}/../.." && pwd -P)"
cd "${source_root}"

fail() {
  echo "Deployment stopped: $*" >&2
  exit 1
}

[[ "${app_root}" == /* && "${app_root}" != "/" ]] || fail "CIRKLE_APP_ROOT must be a non-root absolute path"
[[ -r "${env_file}" ]] || fail "environment file is not readable: ${env_file}"
[[ -r "${ops_env_file}" ]] || fail "backup environment file is not readable: ${ops_env_file}"

for command_name in curl flock git node pm2 pnpm readlink tar; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "required command is unavailable: ${command_name}"
done

for protected_env_file in "${env_file}" "${ops_env_file}"; do
  insecure_mode="$(find "${protected_env_file}" -maxdepth 0 -perm /0027 -print)"
  [[ -z "${insecure_mode}" ]] || fail "${protected_env_file} must not be group-writable or accessible by other users (use mode 0640 or stricter)"
done

if [[ "${run_server_tests}" != "true" && "${run_server_tests}" != "false" ]]; then
  fail "CIRKLE_RUN_SERVER_TESTS must be true or false"
fi

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "run this script from the Cirkle Git checkout"
git diff --quiet || fail "tracked working-tree changes exist; commit or revert them before deployment"
git diff --cached --quiet || fail "staged changes exist; commit them before deployment"

if [[ ! -f prisma/migrations/migration_lock.toml ]]; then
  fail "no committed Prisma migration history exists; production will never use prisma db push"
fi

mkdir -p -- "${app_root}/releases" "${app_root}/shared" "${app_root}/shared/logs"
exec 9>"${app_root}/.deploy.lock"
flock -n 9 || fail "another deploy or rollback is already running"

releases_dir="${app_root}/releases"
current_link="${app_root}/current"
previous_link="${app_root}/previous"
revision_full="$(git rev-parse --verify HEAD)"
[[ "${revision_full}" =~ ^[0-9a-f]{40}$ ]] || fail "could not resolve an immutable Git revision"
revision="${revision_full:0:12}"
release_id="$(date -u +%Y%m%dT%H%M%SZ)-${revision}"
release_dir="${releases_dir}/${release_id}"
previous_release=""
switched=false

if [[ -L "${current_link}" ]]; then
  previous_release="$(readlink -f "${current_link}")"
  [[ "${previous_release}" == "${releases_dir}/"* ]] || fail "current symlink points outside ${releases_dir}"
elif [[ -e "${current_link}" ]]; then
  fail "${current_link} exists but is not a symlink"
fi

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

on_error() {
  local line="$1"
  trap - ERR
  set +e
  echo "Deployment failed at line ${line}. The new release remains at ${release_dir} for inspection." >&2
  if [[ "${switched}" == true ]]; then
    if [[ -n "${previous_release}" ]]; then
      echo "Restoring application symlink to ${previous_release}" >&2
      atomic_link "${previous_release}" "${current_link}"
      reload_release "${previous_release}"
    else
      echo "No prior release exists; removing the failed current symlink and stopping cirkle-api" >&2
      rm -f -- "${current_link}"
      pm2 delete cirkle-api >/dev/null 2>&1
    fi
  fi
  exit 1
}
trap 'on_error "$LINENO"' ERR

mkdir -- "${release_dir}"
echo "Exporting committed revision ${revision} to ${release_dir}"
git archive --format=tar "${revision_full}" \
  | tar -x -C "${release_dir}" --exclude='.env' --exclude='.env.production' -f -

(
  cd "${release_dir}"
  # Production secrets are deliberately not loaded until all dependency
  # lifecycle scripts, compilation, and tests have finished.
  unset JWT_ACCESS_SECRET JWT_REFRESH_SECRET IP_HASH_SECRET OTP_PEPPER \
    ZEPTOMAIL_TOKEN GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET OPENAI_API_KEY \
    GEMINI_API_KEY KLIPY_API_KEY DAILY_API_KEY STORAGE_SIGNING_SECRET \
    MYSQL_PASSWORD MYSQL_ROOT_PASSWORD MYSQL_BACKUP_PASSWORD
  export CI=true
  export DATABASE_URL="mysql://build:build@127.0.0.1:3306/cirkle_build"
  pnpm install --frozen-lockfile --prod=false
  pnpm db:validate
  pnpm db:generate
  pnpm build:api
  if [[ "${run_server_tests}" == "true" ]]; then
    pnpm test:server
  fi
)

# The root-owned file is trusted deployment input, but values stay as shell
# variables instead of being exported wholesale to child processes.
# shellcheck disable=SC1090
source "${env_file}"

require_env() {
  local name="$1"
  local value="${!name:-}"
  [[ -n "${value}" ]] || fail "${name} is empty"
  case "${value}" in
    *CHANGE_ME*|*REPLACE_ME*|*REPLACE_WITH*|*replace-this*|'<'*'>') fail "${name} still contains a placeholder" ;;
  esac
}

required_settings=(
  DATABASE_URL CORS_ORIGINS APP_BASE_URL FRONTEND_URL DEFAULT_COMMUNITY_ID
  JWT_ACCESS_SECRET JWT_REFRESH_SECRET IP_HASH_SECRET OTP_PEPPER
  ZEPTOMAIL_TOKEN ZEPTOMAIL_FROM_EMAIL GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REDIRECT_URI
  OPENAI_API_KEY OPENAI_MODEL GEMINI_API_KEY GEMINI_MODEL
  KLIPY_API_KEY DAILY_API_KEY
  STORAGE_ROOT STORAGE_SIGNING_SECRET
)
for setting in "${required_settings[@]}"; do
  require_env "${setting}"
done

[[ "${NODE_ENV:-}" == "production" ]] || fail "NODE_ENV must equal production"
[[ "${HOST:-}" == "127.0.0.1" ]] || fail "HOST must equal 127.0.0.1 behind Nginx"
[[ "${PORT:-}" == "3001" ]] || fail "PORT must equal 3001 to match Nginx and PM2"
[[ "${TRUST_PROXY_HOPS:-}" == "1" ]] || fail "TRUST_PROXY_HOPS must equal 1 for the DNS-only Nginx origin"
[[ "${COOKIE_SECURE:-}" == "true" ]] || fail "COOKIE_SECURE must equal true"
[[ -z "${COOKIE_DOMAIN:-}" ]] || fail "COOKIE_DOMAIN must be unset so the refresh cookie remains host-only"
[[ "${MOBILE_TEST_MODE:-}" == "false" ]] || fail "MOBILE_TEST_MODE must equal false"
[[ "${ENABLE_SEED_DATA:-}" == "false" ]] || fail "ENABLE_SEED_DATA must equal false in production"
[[ "${APP_BASE_URL}" == "https://api.cirkle.world" ]] || fail "APP_BASE_URL must equal https://api.cirkle.world"
[[ "${FRONTEND_URL}" == "https://cirkle.world" ]] || fail "FRONTEND_URL must equal https://cirkle.world"
[[ "${GOOGLE_REDIRECT_URI}" == "https://api.cirkle.world/api/auth/google/callback" ]] || fail "GOOGLE_REDIRECT_URI is not the registered production callback"
[[ "${STORAGE_ROOT}" == /* && "${STORAGE_ROOT}" != "/" ]] || fail "STORAGE_ROOT must be a non-root absolute path"
if [[ -n "${DAILY_DOMAIN:-}" && ! "${DAILY_DOMAIN}" =~ ^[A-Za-z0-9.-]+$ ]]; then
  fail "DAILY_DOMAIN must be a hostname without a scheme, port, or path"
fi

has_apex=false
has_www=false
IFS=',' read -r -a configured_origins <<<"${CORS_ORIGINS}"
for raw_origin in "${configured_origins[@]}"; do
  origin="${raw_origin#"${raw_origin%%[![:space:]]*}"}"
  origin="${origin%"${origin##*[![:space:]]}"}"
  [[ "${origin}" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || fail "CORS_ORIGINS contains a non-HTTPS, wildcard, or path-bearing origin: ${origin}"
  [[ "${origin}" == "https://cirkle.world" ]] && has_apex=true
  [[ "${origin}" == "https://www.cirkle.world" ]] && has_www=true
done
[[ "${has_apex}" == true && "${has_www}" == true ]] || fail "CORS_ORIGINS must contain both https://cirkle.world and https://www.cirkle.world"

mkdir -p -- "${STORAGE_ROOT}"

echo "Validating the complete production runtime before backup or migration"
(
  cd "${release_dir}"
  NODE_ENV=production HOST=127.0.0.1 PORT=3001 TRUST_PROXY_HOPS=1 \
    node --env-file="${env_file}" --input-type=module \
    --eval 'const { createApp } = await import("./server/dist/app.js"); const { prisma } = await import("./server/dist/lib/prisma.js"); const { probeStorageRoot } = await import("./server/dist/routes/health.js"); createApp(); try { await Promise.all([prisma.$queryRawUnsafe("SELECT 1"), probeStorageRoot()]); } finally { await prisma.$disconnect(); }'
)

echo "Taking a verified database backup before applying migrations"
api_database_url="${DATABASE_URL}"
readonly api_database_url
(
  # shellcheck disable=SC1090
  source "${ops_env_file}"
  DATABASE_URL="${api_database_url}" \
  MYSQL_BACKUP_HOST="${MYSQL_BACKUP_HOST:-}" \
  MYSQL_BACKUP_PORT="${MYSQL_BACKUP_PORT:-}" \
  MYSQL_BACKUP_DATABASE="${MYSQL_BACKUP_DATABASE:-}" \
  node "${release_dir}/deploy/scripts/assert-backup-target.mjs"
)
CIRKLE_ENV_FILE="${ops_env_file}" "${release_dir}/deploy/scripts/backup-mysql.sh"

echo "Applying committed Prisma migrations"
(
  cd "${release_dir}"
  DATABASE_URL="${DATABASE_URL}" pnpm db:migrate:deploy
)

atomic_link "${release_dir}" "${current_link}"
switched=true
reload_release "${release_dir}"

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
  echo "New release did not pass ${health_url}" >&2
  on_error "${LINENO}"
fi

if [[ -n "${previous_release}" ]]; then
  atomic_link "${previous_release}" "${previous_link}"
fi

pm2 save
trap - ERR
echo "Deployment complete: ${release_id}"
echo "Active release: $(readlink -f "${current_link}")"
if [[ -n "${previous_release}" ]]; then
  echo "Rollback release: ${previous_release}"
fi

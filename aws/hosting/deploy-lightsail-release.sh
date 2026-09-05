#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

archive="${1:-/tmp/cirkle-react-source.tar.gz}"
environment_file="${2:-/tmp/cirkle-react-api.env}"
release_id="${RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
release_dir="/srv/cirkle/releases/${release_id}"

[[ "$(id -u)" == "0" ]] || { echo "Run as root" >&2; exit 1; }
[[ -f "${archive}" && -s "${archive}" ]] || { echo "Release archive is missing" >&2; exit 1; }
[[ -f "${environment_file}" && -s "${environment_file}" ]] || { echo "Environment file is missing" >&2; exit 1; }
[[ "${release_id}" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Invalid RELEASE_ID" >&2; exit 1; }

install -d -o cirkle -g cirkle -m 0750 "${release_dir}"
tar --warning=no-unknown-keyword -xzf "${archive}" -C "${release_dir}"
chown -R cirkle:cirkle "${release_dir}"

sudo -H -u cirkle bash -lc "cd '${release_dir}' && export CI=true DATABASE_URL='mysql://build:build@127.0.0.1:3306/cirkle_build'; pnpm install --frozen-lockfile --prod=false && pnpm db:validate && pnpm db:generate && pnpm build:api"

install -o root -g cirkle -m 0640 "${environment_file}" /etc/cirkle/api.env

sudo -H -u cirkle bash -lc "set -a; source /etc/cirkle/api.env; set +a; cd '${release_dir}'; pnpm db:migrate:deploy"

sudo -H -u cirkle bash -lc "cd '${release_dir}' && node --env-file=/etc/cirkle/api.env --input-type=module --eval 'const { createApp } = await import(\"./server/dist/app.js\"); const { prisma } = await import(\"./server/dist/lib/prisma.js\"); const { probeStorageRoot } = await import(\"./server/dist/routes/health.js\"); createApp(); try { await Promise.all([prisma.\$queryRawUnsafe(\"SELECT 1\"), probeStorageRoot()]); } finally { await prisma.\$disconnect(); }'"

previous=""
if [[ -L /srv/cirkle/current ]]; then previous="$(readlink -f /srv/cirkle/current)"; fi
ln -sfn "${release_dir}" /srv/cirkle/current.next
mv -Tf /srv/cirkle/current.next /srv/cirkle/current

systemctl daemon-reload
systemctl enable --now cirkle-api
systemctl restart cirkle-api

ready=false
for attempt in $(seq 1 45); do
  if curl --fail --silent --show-error --max-time 3 http://127.0.0.1:3001/readyz >/tmp/cirkle-ready.json; then
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
    systemctl restart cirkle-api
  fi
  exit 1
fi

cat /tmp/cirkle-ready.json
echo
echo "Release active: ${release_dir}"

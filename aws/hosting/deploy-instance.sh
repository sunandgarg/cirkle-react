#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${DEPLOYMENT_BUCKET:?DEPLOYMENT_BUCKET is required}"
: "${APP_SECRET_ID:?APP_SECRET_ID is required}"

release_id="${RELEASE_ID:-initial}"
release_dir="/srv/cirkle/releases/${release_id}"
import_dir="/srv/cirkle/import/${release_id}"
import_supabase="${IMPORT_SUPABASE:-false}"

chmod 0755 /srv/cirkle
install -d -o cirkle -g cirkle -m 0750 "$release_dir" "$import_dir"
install -d -o root -g cirkle -m 0750 /etc/cirkle
aws s3 cp "s3://${DEPLOYMENT_BUCKET}/releases/cirkle-react-source.tar.gz" /tmp/cirkle-react-source.tar.gz --region "$AWS_REGION"
aws s3 cp "s3://${DEPLOYMENT_BUCKET}/releases/cirkle-react-frontend.tar.gz" /tmp/cirkle-react-frontend.tar.gz --region "$AWS_REGION"
tar --warning=no-unknown-keyword -xzf /tmp/cirkle-react-source.tar.gz -C "$release_dir"
if [[ "$import_supabase" == "true" ]]; then
  aws s3 cp "s3://${DEPLOYMENT_BUCKET}/migrations/supabase-export.tar.gz" /tmp/cirkle-react-supabase-export.tar.gz --region "$AWS_REGION"
  tar --warning=no-unknown-keyword -xzf /tmp/cirkle-react-supabase-export.tar.gz -C "$import_dir"
fi
chown -R cirkle:cirkle "$release_dir" "$import_dir"

app_config="$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$APP_SECRET_ID" --query SecretString --output text)"
database_url="$(jq -er '.DATABASE_URL' <<<"$app_config")"
s3_bucket="$(jq -er '.S3_BUCKET' <<<"$app_config")"

umask 0077
jq -r 'del(.LOCAL_MYSQL_PASSWORD,.LOCAL_MYSQL_ROOT_PASSWORD) | to_entries[] | "\(.key)=\(.value | tostring)"' \
  <<<"$app_config" >/etc/cirkle/api.env
chown root:cirkle /etc/cirkle/api.env
chmod 0640 /etc/cirkle/api.env

sudo -H -u cirkle bash -lc "cd '$release_dir' && pnpm install --frozen-lockfile && pnpm db:generate && pnpm build:api"
sudo -H -u cirkle env DATABASE_URL="$database_url" bash -lc "cd '$release_dir' && pnpm db:migrate:deploy"
if [[ "$import_supabase" == "true" ]]; then
  sudo -H -u cirkle env DATABASE_URL="$database_url" NODE_ENV=production HOST=127.0.0.1 PORT=3001 TRUST_PROXY_HOPS=1 CORS_ORIGINS=https://cirkle-react.cirkle.world APP_BASE_URL=https://cirkle-react.cirkle.world FRONTEND_URL=https://cirkle-react.cirkle.world JWT_ACCESS_SECRET="$(jq -er '.JWT_ACCESS_SECRET' <<<"$app_config")" JWT_REFRESH_SECRET="$(jq -er '.JWT_REFRESH_SECRET' <<<"$app_config")" IP_HASH_SECRET="$(jq -er '.IP_HASH_SECRET' <<<"$app_config")" OTP_PEPPER="$(jq -er '.OTP_PEPPER' <<<"$app_config")" STORAGE_SIGNING_SECRET="$(jq -er '.STORAGE_SIGNING_SECRET' <<<"$app_config")" COOKIE_SECURE=true REQUIRE_PROVIDER_CONFIG=false APPSYNC_ENABLED=false STORAGE_DRIVER=s3 AWS_REGION="$AWS_REGION" S3_BUCKET="$s3_bucket" bash -lc "cd '$release_dir' && pnpm supabase:import:full --file='$import_dir/manifest.json' --apply --upload-objects"
fi

frontend_next="/srv/cirkle/frontend-next-${release_id}"
install -d -o root -g root -m 0755 "$frontend_next"
tar --warning=no-unknown-keyword -xzf /tmp/cirkle-react-frontend.tar.gz -C "$frontend_next"
find /srv/cirkle/frontend -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
cp -a "$frontend_next/dist/." /srv/cirkle/frontend/
chown -R root:root /srv/cirkle/frontend
chmod -R a=rX /srv/cirkle/frontend
ln -sfn "$release_dir" /srv/cirkle/current

systemctl disable --now pm2-cirkle >/dev/null 2>&1 || true
sudo -H -u cirkle pm2 delete all >/dev/null 2>&1 || true
sudo -H -u cirkle pm2 kill >/dev/null 2>&1 || true
cat >/etc/systemd/system/cirkle-api.service <<'SYSTEMD'
[Unit]
Description=Cirkle React Node API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=cirkle
Group=cirkle
WorkingDirectory=/srv/cirkle/current
Environment=HOME=/home/cirkle
ExecStart=/usr/local/bin/node --env-file=/etc/cirkle/api.env --enable-source-maps server/dist/index.js
Restart=always
RestartSec=3
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=/srv/cirkle/shared
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
SYSTEMD
systemctl daemon-reload
systemctl enable --now cirkle-api
install -o root -g root -m 0750 "$release_dir/aws/hosting/backup-local-mysql.sh" /usr/local/sbin/cirkle-mysql-backup
AWS_REGION="$AWS_REGION" BACKUP_BUCKET="$s3_bucket" "$release_dir/aws/hosting/install-budget-services.sh"
nginx -t
systemctl reload nginx

for attempt in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:3001/readyz >/tmp/cirkle-ready.json; then
    break
  fi
  if [[ "$attempt" == 30 ]]; then
    journalctl -u cirkle-api --no-pager -n 100
    exit 1
  fi
  sleep 2
done
curl --fail --silent http://127.0.0.1:3001/healthz
cat /tmp/cirkle-ready.json

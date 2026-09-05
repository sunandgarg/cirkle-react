#!/usr/bin/env bash
set -Eeuo pipefail

api_domain="${API_DOMAIN:-api-react.cirkle.world}"
node_version="${NODE_VERSION:-22.23.2}"
pnpm_version="${PNPM_VERSION:-11.19.0}"
certbot_email="${CERTBOT_EMAIL:-}"

[[ "$(id -u)" == "0" ]] || { echo "Run as root" >&2; exit 1; }
[[ "${api_domain}" =~ ^[a-z0-9.-]+$ ]] || { echo "Invalid API_DOMAIN" >&2; exit 1; }

dnf install -y nginx jq tar gzip xz mariadb105 logrotate cronie certbot python3-certbot-nginx

if ! /usr/local/bin/node --version 2>/dev/null | grep -qx "v${node_version}"; then
  curl --fail --silent --show-error --location \
    "https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-x64.tar.xz" \
    --output /tmp/cirkle-node.tar.xz
  tar -xJf /tmp/cirkle-node.tar.xz -C /usr/local --strip-components=1
  rm -f /tmp/cirkle-node.tar.xz
fi
corepack enable
corepack prepare "pnpm@${pnpm_version}" --activate

if ! id cirkle >/dev/null 2>&1; then
  useradd --system --create-home --user-group --shell /bin/bash cirkle
fi
install -d -o cirkle -g cirkle -m 0750 \
  /srv/cirkle /srv/cirkle/releases /srv/cirkle/shared /srv/cirkle/shared/logs
install -d -o root -g cirkle -m 0750 /etc/cirkle

if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l 2G /swapfile
    chmod 0600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
cat >/etc/sysctl.d/90-cirkle-memory.conf <<'SYSCTL'
vm.swappiness=10
vm.vfs_cache_pressure=50
SYSCTL
sysctl --system >/dev/null 2>&1 || true

cat >/etc/nginx/conf.d/cirkle-api.conf <<NGINX
map \$http_upgrade \$connection_upgrade {
  default upgrade;
  '' close;
}
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name ${api_domain};
  client_max_body_size 21m;

  location = /healthz {
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_pass http://127.0.0.1:3001;
  }
  location = /readyz { deny all; }
  location = /api/readyz { deny all; }
  location /socket.io/ {
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$connection_upgrade;
    proxy_read_timeout 3600s;
    proxy_pass http://127.0.0.1:3001;
  }
  location /api/ {
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_read_timeout 120s;
    proxy_pass http://127.0.0.1:3001;
  }
  location / { return 404; }
}
NGINX
rm -f /etc/nginx/conf.d/default.conf
nginx -t
systemctl enable --now nginx crond

if [[ -n "${certbot_email}" ]]; then
  [[ "${certbot_email}" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || {
    echo "Invalid CERTBOT_EMAIL" >&2
    exit 1
  }
  certbot --nginx --non-interactive --agree-tos --redirect \
    --email "${certbot_email}" --domain "${api_domain}"
fi
systemctl enable --now certbot-renew.timer 2>/dev/null || true

install -d -m 0755 /etc/systemd/journald.conf.d
cat >/etc/systemd/journald.conf.d/cirkle-limits.conf <<'JOURNALD'
[Journal]
SystemMaxUse=200M
RuntimeMaxUse=100M
MaxRetentionSec=14day
JOURNALD
systemctl restart systemd-journald

cat >/etc/systemd/system/cirkle-api.service <<'SYSTEMD'
[Unit]
Description=Cirkle Node API
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
MemoryMax=780M

[Install]
WantedBy=multi-user.target
SYSTEMD
systemctl daemon-reload

cat >/etc/logrotate.d/cirkle-api <<'LOGROTATE'
/srv/cirkle/shared/logs/*.log {
  daily
  maxsize 25M
  rotate 14
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
  su cirkle cirkle
}
LOGROTATE

echo "Lightsail API host bootstrapped for ${api_domain}"

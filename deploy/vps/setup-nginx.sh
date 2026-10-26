#!/usr/bin/env bash
# One command for nginx in front of the PM2 processes on Ubuntu (22.04 / 24.04):
#   1. installs nginx (and certbot) when missing;
#   2. serves the ACME challenge over HTTP and gets a Let's Encrypt certificate for the domain;
#   3. installs deploy/vps/nginx.conf with your domain and ports, checks it, reloads nginx;
#   4. reloads nginx after every automatic certificate renewal.
# Re-runnable: run it again after changing ports or the template; an existing certificate is kept.
#
#   sudo deploy/vps/setup-nginx.sh api.example.com you@example.com
#   sudo SELF_SIGNED=1 deploy/vps/setup-nginx.sh api.example.com     # no public DNS yet: test cert
#
# Environment: API_PORT (3000), GRAPHQL_PORT (3002), SOCKET_PORT (3001), SITE_NAME (app),
# SELF_SIGNED (empty). The domain's DNS A/AAAA record must point at this server first, and ports
# 80 and 443 must be open (ufw allow 80,443/tcp).
set -euo pipefail

DOMAIN=${1:-}
EMAIL=${2:-}
API_PORT=${API_PORT:-3000}
GRAPHQL_PORT=${GRAPHQL_PORT:-3002}
SOCKET_PORT=${SOCKET_PORT:-3001}
SITE_NAME=${SITE_NAME:-app}
SELF_SIGNED=${SELF_SIGNED:-}

TEMPLATE="$(cd "$(dirname "$0")" && pwd)/nginx.conf"
SITE="/etc/nginx/sites-available/$SITE_NAME"
ENABLED="/etc/nginx/sites-enabled/$SITE_NAME"
WEBROOT=/var/www/certbot
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"

fail() { echo "setup-nginx: $*" >&2; exit 1; }
step() { echo "==> $*"; }

[[ $DOMAIN =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] ||
  fail "usage: sudo $0 <domain> [email]   (domain in lower case, e.g. api.example.com)"
[[ $(id -u) -eq 0 ]] || fail "run as root (sudo)"
[[ -f $TEMPLATE ]] || fail "template not found: $TEMPLATE"
for port in "$API_PORT" "$GRAPHQL_PORT" "$SOCKET_PORT"; do
  [[ $port =~ ^[0-9]+$ ]] || fail "ports must be numbers"
done

# nginx under systemd on a server; started directly where there is no systemd (containers, tests).
reload_nginx() {
  nginx -t
  if [[ -d /run/systemd/system ]]; then
    systemctl enable --now nginx >/dev/null
    systemctl reload nginx
  elif pgrep -x nginx >/dev/null; then
    nginx -s reload
  else
    nginx
  fi
}

enable_site() {
  ln -sfn "$SITE" "$ENABLED"
  # Ubuntu's welcome page would answer requests by IP; this site is the only one.
  rm -f /etc/nginx/sites-enabled/default
}

packages=()
command -v nginx >/dev/null || packages+=(nginx)
[[ -n $SELF_SIGNED ]] || command -v certbot >/dev/null || packages+=(certbot)
command -v openssl >/dev/null || packages+=(openssl)
if ((${#packages[@]})); then
  step "Installing ${packages[*]}"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${packages[@]}" >/dev/null
fi

if [[ ! -s $CERT_DIR/fullchain.pem ]]; then
  if [[ -n $SELF_SIGNED ]]; then
    step "Creating a self-signed certificate for $DOMAIN (browsers will warn; rerun without SELF_SIGNED later)"
    mkdir -p "$CERT_DIR"
    openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=$DOMAIN" \
      -keyout "$CERT_DIR/privkey.pem" -out "$CERT_DIR/fullchain.pem" 2>/dev/null
  else
    step "Serving the ACME challenge for $DOMAIN over HTTP"
    mkdir -p "$WEBROOT"
    cat >"$SITE" <<CONF
# Temporary: only the Let's Encrypt challenge, until the certificate exists.
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root $WEBROOT; }
    location / { return 404; }
}
CONF
    enable_site
    reload_nginx
    step "Requesting the certificate"
    account=(--register-unsafely-without-email)
    [[ -n $EMAIL ]] && account=(--email "$EMAIL")
    certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" --non-interactive --agree-tos "${account[@]}"
  fi
else
  step "Keeping the existing certificate in $CERT_DIR"
fi

step "Installing the site for $DOMAIN (api :$API_PORT, graphql :$GRAPHQL_PORT, socket :$SOCKET_PORT)"
mkdir -p "$WEBROOT"
sed -e "s/api\.example\.com/$DOMAIN/g" \
  -e "s/127\.0\.0\.1:3000;/127.0.0.1:$API_PORT;/" \
  -e "s/127\.0\.0\.1:3002;/127.0.0.1:$GRAPHQL_PORT;/" \
  -e "s/127\.0\.0\.1:3001;/127.0.0.1:$SOCKET_PORT;/" \
  "$TEMPLATE" >"$SITE"
enable_site
reload_nginx

if [[ -z $SELF_SIGNED ]]; then
  # certbot's systemd timer renews certificates; nginx must reload to serve the new one.
  hook=/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
  mkdir -p "$(dirname "$hook")"
  printf '#!/bin/sh\nnginx -t && systemctl reload nginx\n' >"$hook"
  chmod 755 "$hook"
fi

cat <<DONE

nginx is serving https://$DOMAIN
  REST      https://$DOMAIN/api/v1        health: https://$DOMAIN/api/ready
  GraphQL   https://$DOMAIN/graphql
  Socket.IO https://$DOMAIN               (path /socket.io/, transports: ['websocket'])
  Stripe    https://$DOMAIN/api/webhooks/stripe
Set TRUST_PROXY=1 and LISTEN_HOST=127.0.0.1 (ecosystem.config.cjs sets it) in the app.
DONE

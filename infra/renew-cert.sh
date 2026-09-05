#!/bin/bash
# Copies the certbot-issued cert into a location Caddy's (non-root)
# service user can actually read, then reloads Caddy to pick it up.
#
# Run this after every `certbot certonly ...` or `certbot renew` —
# Caddy does not watch these files for changes on its own.
#
# Usage: infra/renew-cert.sh <domain>   (e.g. audiolink.example.com)
set -e

DOMAIN="${1:?Usage: renew-cert.sh <domain>}"
DEST=/etc/caddy/certs/$DOMAIN

sudo mkdir -p "$DEST"
sudo cp "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "$DEST/fullchain.pem"
sudo cp "/etc/letsencrypt/live/$DOMAIN/privkey.pem" "$DEST/privkey.pem"
sudo chown -R caddy:caddy "$DEST"
sudo chmod 640 "$DEST"/*.pem

sudo systemctl reload caddy
echo "Copied cert for $DOMAIN and reloaded Caddy."
sudo certbot certificates 2>/dev/null | grep -A2 "$DOMAIN"

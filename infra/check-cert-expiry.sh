#!/bin/bash
# Warns (to stderr, and via a non-zero exit that shows up as a "failed"
# systemd unit) when the TLS cert is close to expiring. Renewal is a
# manual DNS-01 process (see infra/README.md) — nothing else reminds
# anyone before it lapses and breaks the site with a TLS error.
#
# Usage: check-cert-expiry.sh <domain> [warn-days]
# Installed by install.sh as a daily systemd timer
# (audiolink-cert-check.timer). If the station has real alerting
# (email/Nagios/Zabbix/etc.), point it at this script's exit code or at
# 'systemctl is-failed audiolink-cert-check' instead of relying on someone
# noticing the journal.
set -euo pipefail

DOMAIN="${1:?Usage: check-cert-expiry.sh <domain> [warn-days]}"
WARN_DAYS="${2:-14}"

CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
if [ ! -f "$CERT" ]; then
  echo "check-cert-expiry: no cert found at $CERT" >&2
  exit 1
fi

EXPIRY_EPOCH=$(date -d "$(openssl x509 -enddate -noout -in "$CERT" | cut -d= -f2)" +%s)
NOW_EPOCH=$(date +%s)
DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

if [ "$DAYS_LEFT" -le "$WARN_DAYS" ]; then
  echo "WARNING: TLS cert for $DOMAIN expires in $DAYS_LEFT day(s) — renew via infra/README.md's renewal steps." >&2
  exit 1
fi

echo "TLS cert for $DOMAIN expires in $DAYS_LEFT day(s) — OK."

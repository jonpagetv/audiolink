#!/bin/bash
# audiolink — production installer for a dedicated Ubuntu Server host.
#
# Run this FROM WITHIN a checkout of this repo on the target machine:
#   git clone <this repo> /tmp/audiolink-src
#   cd /tmp/audiolink-src
#   sudo bash infra/install.sh
#
# It installs and configures everything this app needs (Node, coturn,
# Caddy, certbot, fail2ban, ufw, unattended-upgrades), deploys the app to
# /opt/audiolink under a dedicated non-login service account, and prints a
# summary of what the station's IT team still needs to do on the network
# side (port forwarding, DNS) at the end.
#
# What this script deliberately does NOT do:
#   - SSH hardening (key-only auth) — see infra/harden-ssh.sh, run
#     separately and only after coordinating with IT about how they
#     already manage SSH access.
#   - Configure the internet gateway / port forwarding / DNS — that's the
#     station IT team's side; this script prints exactly what's needed.
#   - Enable TURNS (TLS-wrapped TURN control channel) — deferred, see
#     docs/security-overview.md for why.
#
# Idempotency: safe to re-run — package installs are no-ops if already
# done, and file deployment steps overwrite in place. Re-running will NOT
# regenerate secrets/passwords already set in an existing server/.env.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
APP_DIR=/opt/audiolink
SERVICE_USER=audiolink
NODE_MAJOR=22   # check https://github.com/nodesource/distributions for the current LTS before relying on this long after install.sh was written

log()  { echo -e "\n\033[1;32m==>\033[0m $*"; }
warn() { echo -e "\033[1;33m!! \033[0m $*" >&2; }
die()  { echo -e "\033[1;31mERROR:\033[0m $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root (sudo bash infra/install.sh)."

# ---------------------------------------------------------------------------
log "Preflight checks"

. /etc/os-release
if [ "${VERSION_ID:-}" != "24.04" ]; then
  warn "Tested on Ubuntu Server 24.04 LTS; this host reports $PRETTY_NAME. Continuing, but watch for package-name/version drift."
fi

curl -fsS --max-time 5 https://deb.nodesource.com >/dev/null 2>&1 || die "No internet access reachable from this host — required for package installation."

command -v git >/dev/null || { apt-get update -qq && apt-get install -y git; }

# ---------------------------------------------------------------------------
log "Configuration"

read -rp "Public domain for this deployment (e.g. audiolink.example.com): " DOMAIN
[ -n "$DOMAIN" ] || die "Domain is required."

echo ""
echo "Deployment mode:"
echo "  1) Cloudflare-proxied (recommended) — Caddy on the standard HTTPS"
echo "     port (443); Cloudflare's free proxy hides this origin's IP for"
echo "     the web app. Requires a Cloudflare account for the domain above,"
echo "     and a few manual steps in its dashboard after this script runs"
echo "     (printed at the end). TURN can never be proxied this way (no"
echo "     browser's WebRTC stack supports it) — it gets its own unproxied"
echo "     subdomain instead, still reachable directly. See"
echo "     infra/README.md's 'Cloudflare proxy + Caddy on 443' section."
echo "  2) Direct, non-standard port — no third-party proxy; Caddy listens"
echo "     on a custom external port instead, chosen mainly to keep casual"
echo "     scanners (which overwhelmingly target 80/443) from finding the"
echo "     app. Simpler, but the origin's real IP is directly exposed to"
echo "     anyone who resolves the domain."
read -rp "Choose [1]: " DEPLOY_MODE_CHOICE
case "${DEPLOY_MODE_CHOICE:-1}" in
  1) DEPLOY_MODE=cloudflare ;;
  2) DEPLOY_MODE=direct ;;
  *) die "Enter 1 or 2." ;;
esac

if [ "$DEPLOY_MODE" = cloudflare ]; then
  EXTERNAL_PORT=443
  TURN_DOMAIN="turn.${DOMAIN}"
else
  read -rp "External HTTPS port [52001]: " EXTERNAL_PORT
  EXTERNAL_PORT="${EXTERNAL_PORT:-52001}"
  TURN_DOMAIN="$DOMAIN"
fi

DETECTED_IP="$(ip -4 addr show scope global | awk '/inet/{print $2}' | cut -d/ -f1 | head -n1)"
read -rp "This server's LAN IP [$DETECTED_IP]: " LAN_IP
LAN_IP="${LAN_IP:-$DETECTED_IP}"
[ -n "$LAN_IP" ] || die "Could not detect a LAN IP and none was entered."

read -rp "Public IP for this deployment, if already known (blank to fill in later): " PUBLIC_IP

echo "Initial Studio password (12+ chars, upper/lower/digit/symbol):"
read -rsp "> " STUDIO_PASSWORD; echo
echo "Initial Admin password (12+ chars, upper/lower/digit/symbol):"
read -rsp "> " ADMIN_PASSWORD; echo

# ---------------------------------------------------------------------------
log "System packages"

apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y curl git ufw fail2ban unattended-upgrades coturn certbot rsync openssh-server

# ---------------------------------------------------------------------------
log "Node.js ${NODE_MAJOR}.x (via NodeSource)"

if ! command -v node >/dev/null || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
node -e 'const [maj,min]=process.versions.node.split(".").map(Number); if (maj<20 || (maj===20 && min<6)) { console.error("Node >=20.6 required for --env-file"); process.exit(1); }'

# ---------------------------------------------------------------------------
log "Caddy (official repo, not Ubuntu's universe package)"

# Always ensure the official repo is in place and caddy is installed FROM
# it, even if some other package already provided an (often much older)
# caddy binary — Ubuntu's own universe package lags badly behind, and
# Cloudflare mode below specifically needs a version Ubuntu's doesn't have.
if [ ! -f /etc/apt/sources.list.d/caddy-stable.list ]; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
fi
apt-get update -qq
apt-get install -y caddy

if [ "$DEPLOY_MODE" = cloudflare ]; then
  CADDY_VER="$(caddy version | grep -oP 'v\K[0-9]+\.[0-9]+' | head -1)" || die "Could not parse a version out of 'caddy version' output — check it manually and compare against the 2.7+ requirement."
  CADDY_MAJOR="${CADDY_VER%%.*}"
  CADDY_MINOR="${CADDY_VER##*.}"
  if [ "$CADDY_MAJOR" -lt 2 ] || { [ "$CADDY_MAJOR" -eq 2 ] && [ "$CADDY_MINOR" -lt 7 ]; }; then
    die "Caddy $CADDY_VER is too old for Cloudflare mode (needs 2.7+ for trusted_proxies). Check 'apt-cache policy caddy' — something may be pinning an older version ahead of the official repo."
  fi
fi

# ---------------------------------------------------------------------------
log "Dedicated service account"

id -u "$SERVICE_USER" >/dev/null 2>&1 || \
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin --create-home "$SERVICE_USER"

# ---------------------------------------------------------------------------
log "Deploying app to $APP_DIR"

mkdir -p "$APP_DIR"
rsync -a --exclude='.git' --exclude='node_modules' --exclude='server/.env' --exclude='server/data' "$REPO_DIR"/ "$APP_DIR"/
# Ownership before npm install, not after — rsync just copied everything
# in as root, and installing as $SERVICE_USER against a root-owned tree
# would fail to write node_modules/.
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

cd "$APP_DIR/server"
sudo -u "$SERVICE_USER" npm install --omit=dev

# ---------------------------------------------------------------------------
log "server/.env"

if [ -f "$APP_DIR/server/.env" ]; then
  warn "server/.env already exists — leaving it untouched. Delete it first if you want this run to regenerate it."
else
  TURN_SECRET="$(openssl rand -hex 32)"
  STUDIO_HASH="$(node hash-password.js "$STUDIO_PASSWORD")" || die "Studio password rejected: $STUDIO_HASH"
  ADMIN_HASH="$(node hash-password.js "$ADMIN_PASSWORD")" || die "Admin password rejected: $ADMIN_HASH"

  cat > "$APP_DIR/server/.env" <<EOF
PORT=3000
TURN_URI=turn:${TURN_DOMAIN}:3478
TURN_SECRET=${TURN_SECRET}
TURN_CRED_TTL_SECONDS=3600
SESSION_TIMEOUT_MINUTES=60
STUDIO_PASSWORD_HASH=${STUDIO_HASH}
ADMIN_PASSWORD_HASH=${ADMIN_HASH}
AUTH_SESSION_HOURS=12
EOF
  chmod 600 "$APP_DIR/server/.env"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

TURN_SECRET_FOR_COTURN="$(grep '^TURN_SECRET=' "$APP_DIR/server/.env" | cut -d= -f2)" || die "TURN_SECRET missing from $APP_DIR/server/.env"

# ---------------------------------------------------------------------------
log "coturn"

sed \
  -e "s|CHANGE_ME_VM_LAN_IP|${LAN_IP}|g" \
  -e "s|CHANGE_ME_PUBLIC_IP|${PUBLIC_IP:-CHANGE_ME_PUBLIC_IP}|g" \
  -e "s|CHANGE_ME_SHARED_SECRET|${TURN_SECRET_FOR_COTURN}|g" \
  "$APP_DIR/infra/turnserver.conf" > /etc/turnserver.conf

if ! grep -q '^TURNSERVER_ENABLED=1' /etc/default/coturn 2>/dev/null; then
  echo 'TURNSERVER_ENABLED=1' >> /etc/default/coturn
fi
systemctl enable --now coturn
systemctl restart coturn

if [ -z "$PUBLIC_IP" ]; then
  warn "Public IP not provided — /etc/turnserver.conf still has CHANGE_ME_PUBLIC_IP in external-ip. Fill it in once known and 'systemctl restart coturn' (see summary at the end)."
fi

# ---------------------------------------------------------------------------
log "Firewall (ufw)"

ufw allow OpenSSH
ufw limit OpenSSH
ufw allow "${EXTERNAL_PORT}/tcp"
ufw allow 3478/tcp
ufw allow 3478/udp
ufw allow 49152:49172/udp
ufw --force enable

# ---------------------------------------------------------------------------
log "fail2ban"

cp "$APP_DIR/infra/fail2ban/caddy-admin-auth.conf" /etc/fail2ban/filter.d/caddy-admin-auth.conf
cp "$APP_DIR/infra/fail2ban/jail-caddy-admin-auth.conf" /etc/fail2ban/jail.d/caddy-admin-auth.conf
cat > /etc/fail2ban/jail.d/sshd.local <<'EOF'
[sshd]
enabled = true
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

# ---------------------------------------------------------------------------
log "Automatic security updates"

cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

# ---------------------------------------------------------------------------
log "systemd service"

cat > /etc/systemd/system/audiolink.service <<EOF
[Unit]
Description=audiolink Node app
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${APP_DIR}/server
ExecStart=/usr/bin/node --env-file=.env index.js
Restart=on-failure
RestartSec=2
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now audiolink

# ---------------------------------------------------------------------------
log "Log rotation for the audit trail"

sed "s|/opt/audiolink|${APP_DIR}|; s|audiolink audiolink|${SERVICE_USER} ${SERVICE_USER}|" \
  "$APP_DIR/infra/logrotate-audiolink" > /etc/logrotate.d/audiolink

# ---------------------------------------------------------------------------
log "TLS certificate (DNS-01 — this pauses for you to create a DNS TXT record)"

if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  warn "A cert for $DOMAIN already exists — skipping issuance. To force a fresh one, remove /etc/letsencrypt/live/$DOMAIN first, or use 'certbot renew' for a normal renewal instead of re-running this script."
else
  echo "About to run certbot in manual DNS-01 mode. It will print a TXT record"
  echo "to create at _acme-challenge.${DOMAIN} — create it with whoever manages"
  echo "that domain's DNS, wait for propagation, then press Enter at the prompt."
  read -rp "Press Enter when ready to continue... "

  certbot certonly --manual --preferred-challenges dns -d "$DOMAIN"
fi

bash "$APP_DIR/infra/renew-cert.sh" "$DOMAIN"

if [ "$DEPLOY_MODE" = cloudflare ]; then
  # Bare hostname, no port — Cloudflare's proxy always presents 443.
  sed "s|audiolink.example.com|${DOMAIN}|g" \
    "$APP_DIR/infra/Caddyfile.cloudflare" > /etc/caddy/Caddyfile
else
  sed \
    -e "s|audiolink.example.com:52001|${DOMAIN}:${EXTERNAL_PORT}|g" \
    -e "s|audiolink.example.com|${DOMAIN}|g" \
    "$APP_DIR/infra/Caddyfile.direct" > /etc/caddy/Caddyfile
fi

caddy validate --config /etc/caddy/Caddyfile || die "Generated Caddyfile failed validation — see output above."

mkdir -p /var/log/caddy
chown caddy:caddy /var/log/caddy
systemctl enable --now caddy
systemctl reload caddy

# ---------------------------------------------------------------------------
log "Cert expiry reminder (daily check, warns in the journal at <14 days left)"

cat > /etc/systemd/system/audiolink-cert-check.service <<EOF
[Unit]
Description=Check audiolink TLS cert expiry

[Service]
Type=oneshot
ExecStart=${APP_DIR}/infra/check-cert-expiry.sh ${DOMAIN} 14
EOF

cat > /etc/systemd/system/audiolink-cert-check.timer <<'EOF'
[Unit]
Description=Daily audiolink TLS cert expiry check

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now audiolink-cert-check.timer

# ---------------------------------------------------------------------------
log "Done. Verifying services..."

for svc in coturn fail2ban audiolink caddy; do
  systemctl is-active --quiet "$svc" && echo "  $svc: active" || warn "  $svc: NOT active — check 'systemctl status $svc'"
done

if [ "$DEPLOY_MODE" = cloudflare ]; then
  PORT_NOTE="443 is used deliberately here — it's one of the fixed ports
Cloudflare's proxy actually forwards. See infra/README.md's 'Cloudflare
proxy + Caddy on 443' section for the reasoning."
else
  PORT_NOTE="No other inbound ports are required. 80/443 are deliberately
NOT used — see docs/security-overview.md for why."
fi

cat <<EOF

=============================================================================
 REQUIREMENTS FOR THE STATION'S IT TEAM (network/gateway side)
=============================================================================

This server:
  LAN IP:  ${LAN_IP}   (reserve this via DHCP, or set it static)
  Domain:  ${DOMAIN}   (must resolve to the router's public IP)

Port forwarding needed at the internet gateway, all pointed at ${LAN_IP}:
  ${EXTERNAL_PORT}/tcp        -> ${LAN_IP}:${EXTERNAL_PORT}     (HTTPS app traffic, via Caddy)
  3478/tcp, 3478/udp   -> ${LAN_IP}:3478       (TURN/STUN signaling)
  49152-49172/udp      -> ${LAN_IP}:49152-49172 (TURN relay media)

${PORT_NOTE}

$( [ -z "$PUBLIC_IP" ] && echo "Public IP was not provided during install — once known, edit
external-ip in /etc/turnserver.conf and run: sudo systemctl restart coturn" )

Recurring: the TLS cert renews via a manual DNS-01 challenge roughly every
60 days (a daily check now warns in the system journal within 14 days of
expiry — 'sudo systemctl status audiolink-cert-check' or
'journalctl -u audiolink-cert-check' to check). Renewal needs someone able
to create a DNS TXT record for ${DOMAIN} each time — see infra/README.md.

Not done by this script (see docs/security-overview.md for details):
  - SSH access hardening (infra/harden-ssh.sh, optional, run separately)
  - Backups of ${APP_DIR}/server/.env and ${APP_DIR}/server/data/ — point
    the station's existing backup process at these, nothing automates
    this today.
$( [ "$DEPLOY_MODE" = cloudflare ] && cat <<CF

=============================================================================
 STILL NEEDED: CLOUDFLARE DASHBOARD (this script can't do these for you)
=============================================================================

1. DNS record for TURN, kept OUTSIDE the proxy (it can never be proxied —
   no browser's WebRTC stack supports tunneling TURN through HTTP(S), and
   Cloudflare's free plan doesn't proxy raw TCP/UDP either way):
     Type: A   Name: turn   IPv4: <this server's public IP>
     Proxy status: DNS only (grey cloud, NOT orange)
   This makes ${TURN_DOMAIN} resolve directly — matches TURN_URI already
   written into server/.env.

2. SSL/TLS -> Overview -> set mode to Full (strict). Keeps the
   Cloudflare<->origin hop encrypted with the real cert this script just
   installed. Don't use Flexible — it'd send login requests in plaintext
   over that last hop.

3. Only once 1 and 2 are done: DNS record for ${DOMAIN} itself -> set
   Proxy status to Proxied (orange cloud). Before this point, everything
   above already works reached directly; flipping this is what actually
   routes the public through Cloudflare.

4. Reissue any previously-shared Studio/Client links if this domain was
   already in use on a different port before — Cloudflare's proxy won't
   listen on anything but its own fixed ports.
CF
)
=============================================================================
EOF

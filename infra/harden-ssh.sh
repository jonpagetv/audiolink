#!/bin/bash
# OPTIONAL, run separately from install.sh — coordinate with the station's
# IT team before running this. Skip entirely if they already manage SSH
# access their own way (bastion host, VPN-only access, an existing key
# policy, centralized auth, etc.); layering this on top without checking
# first could conflict with how they expect to reach the box.
#
# Disables SSH password authentication and root login, requiring key-based
# auth for every account. Refuses to run if the invoking user has no
# authorized_keys entry yet, since applying this without one would lock
# out the very session used to run it.
#
# Usage: sudo bash infra/harden-ssh.sh
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }

TARGET_USER="${SUDO_USER:-$USER}"
AUTH_KEYS="/home/$TARGET_USER/.ssh/authorized_keys"

if [ ! -s "$AUTH_KEYS" ]; then
  echo "Refusing: no key found at $AUTH_KEYS for user '$TARGET_USER'." >&2
  echo "Add a public key there first (ssh-copy-id from your workstation, or paste" >&2
  echo "one in manually), confirm you can log in with it, then re-run this." >&2
  exit 1
fi

DROPIN=/etc/ssh/sshd_config.d/99-audiolink-hardening.conf
cat > "$DROPIN" <<'EOF'
# Installed by infra/harden-ssh.sh — key-based auth only.
PasswordAuthentication no
PermitRootLogin no
KbdInteractiveAuthentication no
EOF

sshd -t   # validate before reloading — a bad config here would lock everyone out
systemctl reload sshd

echo "SSH hardened: password and root login disabled, key-based auth only."
echo "Before closing this session, open a NEW terminal and confirm you can still log in."

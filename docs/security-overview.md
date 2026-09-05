# audiolink — Security & Hardening Overview

**Audience:** the hosting station's IT/network team, for review before this
server joins the network.

**Purpose:** explain what this system is, what it exposes to the network,
and what hardening has been applied — so you can assess it against your
own policies rather than take it on faith.

---

## 1. What this system is

audiolink is a two-way audio link for live radio: a field reporter
("Client") and a studio operator ("Studio") connect browser-to-browser
over WebRTC, so the studio can put a remote contributor to air. A third
page ("Admin") manages call links and system status.

It runs as one Node.js application on one dedicated Linux server, fronted
by a reverse proxy that terminates TLS. There is no database, no other
backend service, and no third-party cloud dependency for the call itself
— audio never passes through any server operated by a third party.

## 2. Architecture, in brief

```
Internet / mobile data          Station LAN
 ┌────────────┐                ┌──────────────────────────────────┐
 │  Client     │                │  Studio operator's browser        │
 │ (reporter's │                │  (on the studio PC, same LAN)     │
 │  phone/     │                └──────────────┬─────────────────┘
 │  laptop)    │                               │
 └──────┬──────┘                               │
        │  HTTPS + WebRTC (audio, via TURN relay)
        └───────────────┬───────────────────────┘
                         ▼
              ┌─────────────────────────┐
              │  This server            │
              │  Caddy (TLS, :443 or    │──▶ Node app (127.0.0.1:3000 only)
              │   :52001 — see §3)      │
              │  coturn (TURN, :3478    │
              │   + relay range)        │
              └─────────────────────────┘
```

- **The Node app never listens on any network interface except
  `127.0.0.1`.** It is not reachable directly from the LAN or the
  internet under any circumstance — Caddy is the only way in.
- **Caddy** terminates TLS and reverse-proxies everything (including the
  WebSocket signaling channel) to the Node app on localhost.
- **coturn** relays the actual audio media between the two browsers.
  Audio is end-to-end encrypted (DTLS-SRTP, part of the WebRTC standard)
  from browser to browser — the relay server carries encrypted media it
  cannot itself decode, the same as any TURN server on the internet.
- Nothing is recorded or stored on the server. There is no database.
  Small JSON files on disk hold the list of active "Links" (call
  addresses) and a plain-text audit log of who started/stopped a call
  and when — no audio, no transcripts.

## 3. Network exposure — what's actually reachable from outside

This deployment picks one of two supported modes at install time (see
`infra/README.md`); which applies here should be confirmed against the
actual running config rather than assumed from this document alone.

**Mode A — direct, non-standard port.** Only three things are reachable
from the internet, all on non-default ports:

| Port | Protocol | Purpose |
|---|---|---|
| 52001 (configurable) | TCP | HTTPS — the only web-facing port. Serves the Client/Studio/Admin pages and the API. |
| 3478 | TCP + UDP | TURN/STUN signaling (coturn) |
| 49152–49172 | UDP | TURN media relay (coturn) — kept to a narrow, fixed range specifically so the firewall rule for it stays small and auditable |

Ports 80 and 443 are deliberately not used at all — the app runs entirely
on a non-standard port, closing the two ports automated internet scanners
overwhelmingly target. This reduces scan noise; it does **not** hide that
the domain exists — any publicly-trusted TLS certificate, including this
one, is permanently logged in public Certificate Transparency logs
regardless of which port serves it. Real protection is the access
control described in §4–5, not the port choice.

**Mode B — Cloudflare-proxied.** The web app moves to standard HTTPS
(443), fronted by Cloudflare's proxy — the public sees Cloudflare's edge
IP for the web app, not this origin's real one. TURN is unaffected either
way: no browser's WebRTC implementation can tunnel TURN through an
HTTP(S) proxy, so it keeps a directly-reachable port regardless of mode
— on its own unproxied subdomain in this mode, so its DNS record doesn't
inherit the main hostname's proxy status.

| Port | Protocol | Purpose |
|---|---|---|
| 443 | TCP | HTTPS to Cloudflare's edge — the origin's real IP is not what the public connects to for this hostname |
| 3478 | TCP + UDP | TURN/STUN signaling (coturn), directly reachable, unproxied |
| 49152–49172 | UDP | TURN media relay (coturn), same as Mode A |

Both modes need `trusted_proxies`-equivalent care only in Mode B: once a
proxy is in front, the origin's firewall/fail2ban/rate-limiting need to
attribute requests to the real visitor IP rather than the proxy's edge
IP, or those controls silently stop discriminating between real clients.
This deployment's Caddy config does this explicitly — see
`infra/Caddyfile.cloudflare`.

No other inbound port is required in either mode. SSH (port 22, or
whatever your standard is) is a separate, IT-managed concern — see §7.

## 4. Application-layer hardening

- **Authentication.** `/studio` and `/admin` require login (session
  cookie, `HttpOnly; Secure; SameSite=Lax`). Two roles, Studio and Admin,
  each fully independent — the reporter-facing Client page and the
  underlying call-signaling API never require login (a reporter has no
  account to manage).
- **Password storage.** scrypt (Node's built-in, audited implementation),
  a memory-hard hash designed to resist offline brute-forcing even if the
  hash file were somehow exfiltrated. Compared with a constant-time
  comparison (`crypto.timingSafeEqual`) to avoid timing side-channels.
- **Password policy.** At least 12 characters, including an uppercase
  letter, a lowercase letter, a number, and a symbol — enforced
  server-side on every password set or changed, not just suggested in
  the UI.
- **Brute-force protection.** A hand-rolled rate limiter caps every `/api/*`
  route (including login) at 120 requests/minute per IP. Independently,
  fail2ban watches the reverse proxy's access log for repeated 401
  (unauthorized) responses and bans an offending IP for 1 hour after 5
  failures in 10 minutes — this covers login attempts specifically,
  since a failed login is itself a 401.
- **Session model.** Sessions are server-side and immediately
  invalidatable (Logout actually ends the session, not just a
  client-side redirect) and expire automatically after a configurable
  number of hours. Changing a password takes effect immediately for new
  logins without forcibly logging out anyone already using that
  role — relevant because a live broadcast shouldn't be interrupted by
  an unrelated admin action.
- **CSRF.** The session cookie's `SameSite=Lax` attribute means it is
  never sent on a cross-site POST, which covers every state-changing
  route (creating/deleting a Link, admin actions, password changes)
  without needing a separate CSRF token scheme.
- **Unguessable, safe-fail call addresses.** Each "Link" (call address) is
  a `crypto.randomUUID()` — 122 bits of randomness, not practically
  guessable even without rate limiting. A bad, deleted, or never-existent
  Link ID all fail identically (generic 404) so a scan can't distinguish
  "wrong" from "used to exist."
- **Input validation.** Free-text fields (Link names, client-reported
  diagnostic detail strings) are length-capped server-side. The one
  unauthenticated endpoint that *writes* anything (a client/studio
  self-reported "call quality" event) only actually logs while that
  specific call is verifiably live, so a stray request against an idle
  Link can't be used to spam the audit log.
- **No secrets in client-side code.** The long-lived TURN shared secret
  never reaches the browser; the server mints short-lived (1 hour),
  single-use-scope TURN credentials per session via the standard TURN
  REST API pattern.

## 5. Host and network hardening (this deployment)

Applied by `infra/install.sh` when this server was provisioned:

- **Principle of least privilege.** The app runs under a dedicated,
  non-interactive system account (`audiolink`, no login shell, no
  password) — not a personal or shared login. `server/.env` (which holds
  the TURN shared secret and password hashes) is `chmod 600`, readable
  only by that account.
- **Host firewall (ufw).** Default-deny inbound; only the three ports in
  §3 plus SSH are open. SSH additionally has a connection-rate limit
  (`ufw limit`) as a first layer against brute-forcing, independent of
  fail2ban.
- **Automatic security updates** (`unattended-upgrades`) — the OS patches
  itself; this server won't quietly drift out of date sitting in a rack.
- **Process resilience.** The app runs as a systemd service
  (`Restart=on-failure`), so it recovers from a crash and survives a
  reboot without anyone needing to remote in and start it by hand.
- **Log rotation.** Both the reverse proxy's access log and the app's own
  audit log are bounded (rotated/compressed on a schedule) rather than
  growing forever.
- **Certificate expiry monitoring.** Renewal is a manual step (see §6) —
  a daily systemd timer checks the certificate's remaining validity and
  raises a visible warning (in the system journal, surfaced as a failed
  systemd unit) starting 14 days before expiry, so a missed renewal
  doesn't silently take the service down with no warning.
- **TURN relay hardening.** The relay server explicitly disables its
  unused CLI/management interface and rejects loopback peer addresses.
  (See §6 for what was *not* changed here, and why.)

## 6. Known, deliberately accepted trade-offs

Documented rather than silently left out — happy to discuss any of
these if your policies require a different answer:

- **TURN's own control channel is not TLS-wrapped (no TURNS).** The
  actual audio is already end-to-end encrypted regardless (DTLS-SRTP, a
  property of WebRTC itself, not of the TURN transport). Leaving TURN's
  control channel (allocation/permission signaling — not audio content)
  unencrypted means an on-path network observer could see that a call is
  being set up, not what's said on it. Adding TURNS would require a
  second certificate deployment path and an extra open port; deferred as
  a defense-in-depth item rather than a functional gap.
- **A broad "deny relay to private IP ranges" rule was deliberately not
  applied to the TURN relay**, despite being common general TURN-server
  hardening advice (it prevents a relay being abused to reach internal
  LAN services). In this app's specific architecture, both call
  participants always use relay-only candidates, so the "peer" address
  the TURN server relays to is its own other allocation on this same
  box — which itself sits on this station's private LAN. A blanket
  private-range denial would have blocked the relay's own normal
  operation. The unambiguous, safe parts of that hardening (disabling
  the loopback-peer path and the unused CLI) were applied; the rest
  needs a more careful, tested rule set to avoid breaking the service.
- **SSH hardening (disabling password login, requiring keys) is provided
  as a separate, optional script** (`infra/harden-ssh.sh`), not applied
  automatically. Your team may already manage SSH access a specific way
  (bastion host, VPN, centralized key management) — this avoids
  conflicting with that without a conversation first.
- **TLS certificate renewal is a manual step**, roughly every 60 days,
  requiring someone able to create a DNS TXT record for the domain (a
  "DNS-01" challenge — chosen specifically so the server never needs an
  inbound port open for certificate issuance/renewal, unlike the more
  common HTTP-01 method). Mitigated with the expiry-warning timer in §5,
  but the renewal action itself is still manual by design.
- **No backup automation is included.** Two things on this server matter
  and aren't in version control: `server/.env` (secrets) and
  `server/data/` (the Links registry and audit log). We recommend
  pointing your existing backup process at these paths; nothing here
  does that automatically today.

## 7. What this deployment needs from your team

- **Network:** forward the three ports in §3 to this server's LAN IP;
  no others. A DHCP reservation or static IP for this server, so the
  forwarding rule doesn't drift.
- **DNS:** the domain this deployment uses must resolve to your public
  IP, and needs a TXT record created (briefly, at issuance and each
  renewal — see §6) for certificate validation.
- **SSH access policy:** decide with us whether to run
  `infra/harden-ssh.sh`, or manage access your own way instead.
- **Backups:** point your existing backup process at `server/.env` and
  `server/data/` on this host, per §6.
- **Physical security:** standard rack-room access control — out of
  scope for this document, assumed already handled.

---

*This document describes the deployment as installed by
`infra/install.sh` and the application code as of this writing. If either
changes materially, this document should be revisited.*

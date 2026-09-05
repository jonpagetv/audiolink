# infra

## coturn (Stage 0)

```bash
sudo apt install -y coturn
sudo cp infra/turnserver.conf /etc/turnserver.conf
```

Edit `/etc/turnserver.conf` and set:
- `listening-ip` to the VM's LAN IP (`ip -4 addr show scope global`) —
  coturn's autodiscovery can run before the interface has an address at
  boot and crash-loop with "Cannot configure any meaningful IP listener
  address"; an explicit IP avoids that.
- `static-auth-secret` to a real secret (generate with
  `openssl rand -hex 32`). Put the same value in `server/.env` as
  `TURN_SECRET`, and set `TURN_URI=turn:<same-lan-ip>:3478` there too.

Enable and start:

```bash
echo 'TURNSERVER_ENABLED=1' | sudo tee -a /etc/default/coturn
sudo systemctl enable --now coturn
sudo systemctl status coturn   # confirm it's actually "active (running)"
```

If it was previously crash-looping (systemd rate-limits restarts after
repeated failures — check with `systemctl status coturn` and
`journalctl -u coturn -n 50`), you may need `sudo systemctl reset-failed
coturn` before it will start again.

### Stage 0 gate: trickle-ICE test

Use Trickle ICE (https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/)
with a TURN server entry:

- URI: `turn:<vm-lan-ip>:3478`
- Username/Credential: mint a pair the same way the Node server does —
  `GET http://<vm-lan-ip>:3000/api/ice-config` once `server/.env` is set,
  and copy the `username`/`credential` from the response.

Gate passes when you see `relay` candidates gathered successfully.

## Node app as a systemd service

Previously started by hand (`node --env-file=.env index.js`, left running
in the foreground/background of a terminal), which doesn't survive a VM
reboot. `infra/audiolink.service` runs the exact same command as a
proper service that starts on boot and restarts itself if it ever crashes.

```bash
sudo cp infra/audiolink.service /etc/systemd/system/audiolink.service
sudo systemctl daemon-reload
sudo systemctl enable --now audiolink
sudo systemctl status audiolink   # confirm "active (running)"
```

If the app was already running manually when you do this, stop the manual
process first (`ps aux | grep index.js`, then `kill <pid>`) so the service
doesn't collide with it over port 3000.

Logs go to the journal instead of a terminal: `sudo journalctl -u
audiolink -f` to follow them live, or `-n 100` for the last 100 lines.

After pulling code changes: `sudo systemctl restart audiolink` (no
change to this deploy step from before — just a different command to
restart with).

### Gate

`sudo reboot`, then once the VM is back: `systemctl is-active
audiolink` reports `active` with no manual step, and `/login` loads
immediately without needing to SSH in and start anything by hand.

## Caddy + real TLS (Stage 5: field test)

Once a domain points at the router's public IP, Caddy fronts the Node
app and terminates TLS. **Deliberately not using Caddy's automatic
HTTPS** — that needs 80/443 reachable for Let's Encrypt's HTTP/TLS-ALPN
challenge, and the goal here is to keep those closed entirely (no
well-known web ports open to the internet). Instead: a real,
publicly-trusted cert obtained via certbot's **DNS-01 challenge**
(proves domain ownership through a DNS TXT record, not an inbound
connection — no port needs to be open for issuance) and served on the
same non-standard port already in use, port 52001.

Trade-off of this path: renewal (~every 60 days, certs are valid 90)
is a manual step, not automatic — put a reminder somewhere. See "Why
not automatic" below for the alternative if that becomes a hassle.

**Router port forwarding** — narrower than a standard Caddy setup,
*no* 80/443 at all:
- `52001/tcp` (external) -> VM **52001** (internal) — the app itself.
  This changes the existing forward's *internal* target port from
  3000 to 52001: Caddy is now the edge, Node is behind it.
- `3478/udp` and `3478/tcp` — coturn STUN/TURN
- `49152:49172/udp` — coturn relay port range

**coturn**: add `external-ip=<public-ip>/<lan-ip>` to
`/etc/turnserver.conf` (already in `infra/turnserver.conf` as a
placeholder to fill in) and restart. Without this, coturn hands
external peers a relay candidate on the VM's private LAN IP —
unreachable from the internet, so TURN silently works for on-prem
peers only and fails for the field client.

**Get the cert** (interactive — run this yourself, it'll pause and ask
you to create a DNS record):

```bash
sudo apt install -y certbot
sudo certbot certonly --manual --preferred-challenges dns -d audiolink.example.com
```

It prints a TXT record to create at `_acme-challenge.audiolink.example.com`
in whatever dashboard manages the domain's DNS. Add it, wait a minute
or two for propagation, then confirm at the prompt. Verify it actually
propagated first if you want to avoid a failed attempt:
`dig +short TXT _acme-challenge.audiolink.example.com`.

**Deploy Caddy + the cert**:

```bash
sudo apt install -y caddy
sudo cp infra/Caddyfile /etc/caddy/Caddyfile
bash infra/renew-cert.sh audiolink.example.com   # copies the cert somewhere Caddy can read, reloads Caddy
sudo systemctl status caddy   # confirm "active (running)"
```

certbot's cert files are root-only by default; `renew-cert.sh` copies
them into a `caddy`-owned location Caddyfile actually points at and
reloads Caddy to pick them up — Caddy does not watch
`/etc/letsencrypt/live/` for changes on its own.

**Renewal, every ~60 days**: `sudo certbot certificates` shows the
current expiry. When it's due:

```bash
sudo certbot renew --preferred-challenges dns
bash infra/renew-cert.sh audiolink.example.com
```

`renew` re-prompts for a fresh DNS TXT record the same way the first
issuance did (manual mode isn't automatable without a DNS API token —
that's the trade-off of avoiding one). If a cert is allowed to
actually expire before this happens, the site breaks with a TLS error
until renewed.

**server/.env**: `TURN_URI` should already be
`turn:audiolink.example.com:3478` — the domain resolves the same from
the LAN and the public internet, so both on-prem and field peers use
the same value. (coturn's own port is unaffected by any of the above —
it isn't behind Caddy.)

### Why not automatic (DNS-01 via a Caddy plugin)

Considered and deferred: Caddy can fully automate DNS-01 too, via a
DNS-provider-specific plugin (e.g. `caddy-dns/cloudflare`), removing
the manual renewal step entirely. Two reasons this isn't the default
here: the plain `apt install caddy` package has no DNS plugins built
in (needs a custom build via `xcaddy` or caddyserver.com/download),
and it requires a DNS API token with edit rights stored on the VM — a
new, fairly powerful secret to manage. Revisit if manual renewal
proves too easy to forget.

### Note on "hiding" behind a non-standard port

⚠ **Superseded** by putting Cloudflare's proxy in front (see "Cloudflare
proxy + Caddy on 443" below) — kept here as the reasoning that held
*before* that change, for anyone reading the history.

This keeps casual/automated scanners (which overwhelmingly target
80/443) from stumbling onto the app, and keeps 80/443 genuinely
closed. It does **not** hide that `audiolink.example.com` exists: any
publicly-trusted cert (this one included) gets logged permanently and
publicly in Certificate Transparency logs (crt.sh, censys, etc.),
independent of which port serves it. Real access control — `/admin`
auth, rate limiting — is still the Stage 6 hardening item that
actually matters; this is a supplementary reduction in noise, not a
substitute.

### Stage 5 gate

Real client on mobile data (not Wi-Fi, to actually exercise the WAN
path) hitting `https://audiolink.example.com:52001/client`, studio on
`https://audiolink.example.com:52001/studio` (retiring the dev-only
insecure-origin flag now that a real cert exists). Link connects,
holds, and latency/quality meet spec.

## Cloudflare proxy + Caddy on 443

Fronting the web app (not TURN — see below) with Cloudflare's proxy, so
casual reconnaissance of the website hits Cloudflare's edge instead of
this origin's real IP. See `docs/security-overview.md` for the full
rationale and what this does and doesn't protect against — short version:
this hides the origin IP for page loads/login/signaling, but TURN's media
relay fundamentally can't be proxied this way (no browser's WebRTC stack
supports a non-UDP/TCP/TLS transport for TURN, and Cloudflare's free plan
only proxies HTTP(S)/WebSocket, not arbitrary TCP/UDP — that's the paid
Spectrum product). Currently a manual setup; making the port
configurable (this vs. the old non-standard-port approach) in
`infra/install.sh` is a deferred follow-up once this is confirmed working
end to end.

**Why Caddy moves to port 443**: Cloudflare's free plan only proxies a
fixed set of ports, and 443 is the one that lets visitors use a plain
`https://audiolink.example.com` URL with nothing to type or remember.
Router forwarding becomes a straight `443 -> 443`, replacing the old
`52001 -> 52001` rule — no port-splitting between what the public sees
and what the origin listens on.

**Caddy version requirement**: the `trusted_proxies` global option below
needs Caddy **2.7 or newer** — Ubuntu's own `apt` package can lag well
behind this (2.6.2 on a box that installed it before `infra/install.sh`
existed, for instance). Check with `caddy version`; if it's old, pull the
current release from Caddy's own repo instead:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
caddy version   # confirm 2.7+
```

**TURN needs its own, unproxied subdomain.** A DNS record's proxy status
is per-hostname, not per-port — `audiolink.example.com` can't be proxied
for port 443 and unproxied for port 3478 at the same time. In Cloudflare:

- Add an A record: name `turn` (giving `turn.audiolink.example.com`),
  same origin IP as the main record, **Proxy status: DNS only** (grey
  cloud, not orange).
- Update `TURN_URI` in `server/.env` to
  `turn:turn.audiolink.example.com:3478`.
- No coturn config changes — `listening-ip`/`external-ip` are plain IPs,
  not hostname-aware. No cert needed either — coturn isn't doing TLS
  here (`no-tls`/`no-dtls`, already the case). Router forwarding for
  `3478/tcp`, `3478/udp`, and `49152:49172/udp` is unchanged — this
  traffic never touches Cloudflare.

**Cloudflare SSL/TLS mode**: set to **Full (strict)** (SSL/TLS →
Overview) — keeps the Cloudflare↔origin hop encrypted using Caddy's
existing real cert. Don't use Flexible; it'd send login requests over
plain HTTP on that last hop.

**Why `trusted_proxies` is required, not optional**: once Cloudflare
proxies the site, every connection Caddy sees comes from Cloudflare's own
edge IPs, not the real visitor. Without telling Caddy to trust and unwrap
Cloudflare's forwarded-IP header specifically, both fail2ban (which reads
Caddy's access log) and the app's own per-IP rate limiter would start
seeing Cloudflare's IP for every request — silently defeating both, and
in the worst case risking a ban landing on one of Cloudflare's own IPs
instead of an actual attacker's. `infra/Caddyfile` already lists
Cloudflare's published ranges in a `trusted_proxies static` block —
spot-check them against <https://www.cloudflare.com/ips/> occasionally,
since Cloudflare does update this list (rarely, but not never).

**Deploy**:

```bash
sudo cp infra/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile   # confirm no errors before reloading
sudo systemctl reload caddy
```

### Rollout order

Doing these out of order leaves a window where either the site is
unreachable or IP-based protections are blind. In order:

1. Add the `turn.audiolink.example.com` DNS-only record; update
   `TURN_URI` in `.env`; restart the app (`sudo systemctl restart
   audiolink` or `web-audio-link`, whichever this host's unit is
   currently named). Verify a call still connects — this step has zero
   interaction with Cloudflare yet, so it's safe to test in isolation.
2. Upgrade Caddy to 2.7+ if needed.
3. Set Cloudflare's SSL/TLS mode to Full (strict).
4. Change the router's forward rule from `52001 -> 52001` to `443 ->
   443`.
5. Deploy the updated `infra/Caddyfile` (port 443, `trusted_proxies`,
   `auto_https off`) and reload Caddy. At this point
   `https://audiolink.example.com:52001` stops working and
   `https://audiolink.example.com:443` (i.e. just `https://
   audiolink.example.com`) should work when reached directly — the
   proxy toggle isn't on yet, so this is still origin-to-browser
   directly, a safe point to confirm the port move alone works.
6. Only now flip `audiolink.example.com`'s DNS record to proxied (orange
   cloud) in Cloudflare — `trusted_proxies` is already in place from
   step 5, so there's no gap where IP-based protections are blind.
7. Reissue any previously-shared Studio/Client links that still have
   `:52001` in them — those will no longer resolve to anything Cloudflare
   listens on for a proxied hostname.

## Hardening (Stage 6)

Four pieces, all already reflected in `infra/Caddyfile` /
`server/index.js` / `infra/fail2ban/`:

1. **TLS enforcement**: Node's `app.listen()` binds to `127.0.0.1`
   only — it isn't reachable at all except through Caddy, from the LAN
   or anywhere else. No config needed beyond what's already in the
   code.
2. **`/admin` and `/studio` auth**: originally HTTP Basic Auth in Caddy;
   superseded in the multi-link work's Stage 1 by a real login in the
   Node app itself (session cookie, working Logout) — see "Multi-link
   capability" below. `/client` and the shared API routes stay open.
3. **Rate limiting**: a small hand-rolled in-memory limiter in
   `server/index.js` (no new dependency) on all `/api/*` routes — 120
   requests/minute per IP, generous enough for normal 5s polling
   across a few tabs behind a shared/NAT'd IP, tight enough to block
   scripted abuse of TURN credential minting.
4. **fail2ban**: watches Caddy's JSON access log
   (`/var/log/caddy/access.log`) for repeated 401s on `/admin` and
   bans the IP — 5 failures in 10 minutes gets a 1 hour ban. Filter/jail
   definitions in `infra/fail2ban/`.

Deploy:

```bash
sudo mkdir -p /var/log/caddy
sudo chown caddy:caddy /var/log/caddy
sudo cp infra/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy

sudo apt install -y fail2ban
sudo cp infra/fail2ban/caddy-admin-auth.conf /etc/fail2ban/filter.d/caddy-admin-auth.conf
sudo cp infra/fail2ban/jail-caddy-admin-auth.conf /etc/fail2ban/jail.d/caddy-admin-auth.conf
sudo systemctl enable --now fail2ban
sudo fail2ban-client status caddy-admin-auth   # confirm the jail is active
```

Restart the Node app afterward too, to pick up the localhost-only bind
and the rate limiter if it's currently running from before this change.

### Stage 6 gate

`curl http://<lan-ip>:3000/api/session` from another LAN device fails
to connect (was previously reachable). `/admin` login rejects wrong
credentials with 401; 5+ wrong attempts within 10 minutes gets the IP
banned (`sudo fail2ban-client status caddy-admin-auth` shows it under
"Banned IP list") — the filter matches on status 401 in Caddy's proxied
log regardless of which layer produced it, so this held even after
Stage 1 of multi-link moved auth from Caddy into Node. Hammering
`/api/ice-config` past 120 requests/minute from one IP gets 429s.

## Multi-link capability

### Stage 1: auth foundation

Real login replacing Caddy's HTTP Basic Auth — a working Logout needs
an actual invalidatable session, which Basic Auth's browser-cached
credentials can't cleanly support. Two fixed accounts (username is the
role: `studio` or `admin`), scrypt-hashed passwords (Node's built-in
`crypto`, no new dependency), opaque session token in an `HttpOnly;
Secure; SameSite=Lax` cookie, in-memory session store (losing sessions
on a restart just means logging in again — unlike the Stage 2+ Links
registry, this doesn't need to survive one).

`/studio*` now requires the `studio` role (or `admin`, which outranks
it); `/admin*` and `/api/admin/*` require `admin`. `/client`, `/api/session`,
`/api/ice-config`, and `/signal` are unaffected — clients never log in.

Deploy:

```bash
sudo cp infra/Caddyfile /etc/caddy/Caddyfile   # drops the old basicauth block
sudo systemctl reload caddy
```

Set/rotate a password: `node server/hash-password.js '<password>'`,
put the result in `server/.env` as `STUDIO_PASSWORD_HASH` or
`ADMIN_PASSWORD_HASH`, restart the Node app.

Gate: confirmed — `/studio` and `/admin` redirect to `/login` when
logged out; wrong credentials get 401; a `studio` login can reach
`/studio` but gets 401 from `/api/admin/*`; an `admin` login can reach
both; Logout actually invalidates the session server-side (not just a
client-side redirect — confirmed by re-requesting the page after
logging out).

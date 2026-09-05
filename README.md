# audiolink

A self-hosted, two-way audio link for live radio: a field reporter and a
studio operator connect browser-to-browser over WebRTC, so the studio can
put a remote contributor to air — no app install, no third-party calling
service, and no cloud dependency for the audio itself.

Runs entirely on infrastructure you control: one Node.js app, a TURN relay
(coturn), and a TLS-terminating reverse proxy (Caddy), deployable to a
single dedicated Linux host.

## How it works

- **Client** — a reporter opens a link on their phone or laptop and clicks
  Start. No account, no setup.
- **Studio** — an operator logs in, arms a named "Link," and answers when
  the reporter connects. Audio flows directly between the two browsers
  (WebRTC, relayed through your own TURN server — never through a
  third-party server).
- **Admin** — manage Links, force-terminate a live call, toggle system-wide
  availability, change passwords, and review an audit log of activity.

Multiple studios can each run independent, concurrently-live "Links" —
uniquely named, shareable call addresses that a Studio operator arms and a
Client connects to, fully isolated from every other Link in flight.

## Documentation

| Doc | Audience |
|---|---|
| [`docs/requirements.md`](docs/requirements.md) | Full functional spec |
| [`docs/security-overview.md`](docs/security-overview.md) | What's exposed to the network and how it's hardened — written for a hosting site's IT/network review |
| [`docs/user-guide.md`](docs/user-guide.md) | Studio/Admin walkthrough for day-to-day operators |
| [`infra/README.md`](infra/README.md) | Manual, step-by-step deploy notes (coturn, Caddy/TLS, hardening) |
| [`CLAUDE.md`](CLAUDE.md) | Architecture decisions and full project history, stage by stage |
| [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) | Every open-source dependency this project uses, and its license |

## Deploying

Target: a dedicated Ubuntu Server 24.04 LTS host with internet access.
[`infra/install.sh`](infra/install.sh) automates the full install — Node,
Caddy, coturn, certbot, fail2ban, ufw, unattended-upgrades, the systemd
service, log rotation, and a TLS-cert-expiry check — and prints exactly
what your network team needs to open at the gateway once it's done.

```bash
git clone https://github.com/<you>/audiolink.git /tmp/audiolink-src
cd /tmp/audiolink-src
sudo bash infra/install.sh
```

It'll prompt for a domain, a **deployment mode** (below), an initial
Studio/Admin password, and pause once at certbot's DNS-01 step (create one
DNS TXT record, confirm, done). Read through the script before running it
— see `infra/README.md` for what each piece does and how to do the
equivalent by hand.

### Choosing a deployment mode

Two ways to expose this to the internet, picked at install time:

| | **Cloudflare-proxied** (recommended) | **Direct, non-standard port** |
|---|---|---|
| Public URL | `https://your-domain` (standard 443, nothing to type) | `https://your-domain:52001` (or any port you pick) |
| Origin IP exposure | Hidden for the web app — Cloudflare's edge IP is what the public sees and connects to | Directly exposed — anyone who resolves the domain gets the real IP |
| Requires | A free Cloudflare account for the domain, plus a few one-time dashboard steps the installer prints for you | Nothing beyond DNS pointing at your router |
| TURN (audio relay) | Same in both modes — it can **never** go through Cloudflare's proxy or any similar HTTP(S) proxy. No browser's WebRTC stack supports tunneling TURN over HTTP(S)/WebSocket, so the relay server's IP is always directly reachable regardless of which mode you pick. Cloudflare mode gives TURN its own unproxied subdomain; direct mode shares the main domain. | |

If you're not sure, pick Cloudflare — it's free and meaningfully reduces
what a casual scan of your domain reveals about the web app, with the one
caveat above about TURN. See
[`docs/security-overview.md`](docs/security-overview.md) for the full
reasoning, and `infra/README.md`'s "Cloudflare proxy + Caddy on 443"
section for the exact manual steps.

For local development instead of a real deployment, see the "Dev
environment" section of `CLAUDE.md`.

## Stack

- **Backend**: Node.js + Express, `ws` for WebSocket signaling — see
  `server/index.js`.
- **Frontend**: plain HTML/CSS/JS, no framework, no build step —
  `server/public/{client,studio,admin,login}`.
- **Media relay**: [coturn](https://github.com/coturn/coturn) (TURN/STUN).
- **TLS/reverse proxy**: [Caddy](https://caddyserver.com/).
- **Auth**: scrypt-hashed passwords, server-side sessions — no third-party
  auth provider.

Full dependency and license list in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Development

Built iteratively with [Claude Code](https://claude.com/claude-code) as a
pair-programming collaborator — `CLAUDE.md` doubles as both the project's
architecture-decision record and Claude's own working context across
sessions, so it reads more like a running dev log than typical docs. Every
change was reviewed and tested (via the real API/UI, not just code review)
before being accepted; see `CLAUDE.md`'s "Gate: confirmed" notes throughout
for what was actually verified at each stage.

## License

MIT — see [`LICENSE`](LICENSE). Third-party dependencies keep their own
licenses; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

The audiolink logo under `server/public/shared/img/` is a proprietary
brand asset, not covered by the MIT license above.

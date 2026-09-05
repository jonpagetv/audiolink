# audiolink — Project Context for Claude Code

Read `docs/requirements.md` first — it's the source of truth for what
this system must do. This file covers *how* we're building it and
where we currently are.

## Architecture decisions (already made — don't re-litigate these)

- **WebRTC end-to-end** for the audio link. Opus codec (WebRTC default)
  meets the latency/bitrate/quality requirements out of the box — no
  custom codec work.
- **Single relay port**: every peer connects via TURN using
  `iceTransportPolicy: 'relay'`, through **coturn**. Deliberate choice
  to keep the firewall config to one predictable port rather than
  relying on peer-to-peer NAT traversal. This holds regardless of how
  many physical machines are involved — it's what makes the Local
  Server/Studio PC split below a pure deployment change, not a
  signaling change.
- **Local Server and Studio PC are separate on-prem machines**
  ("Architecture 1" — revised from the original single-box plan, where
  the Local Server also hosted studio audio directly). The Local
  Server hosts the web app (signaling + TURN) only. Studio audio I/O
  lives on its own dedicated PC (Windows or Linux) on the same LAN,
  running nothing but a browser pointed at the Local Server's
  `/studio` page. This removes the need for VM USB passthrough
  entirely — the Studio PC has its own real, directly-attached audio
  interface. See "Studio deployment" below.
- **Client and Studio are symmetric browser peers**, same
  getUserMedia/RTCPeerConnection code path for both — do not build a
  separate server-side WebRTC stack (mediasoup/GStreamer) for MVP.
- **Three web UIs served off one Node app**: `/client`, `/studio`,
  `/admin`, all from the Local Server. Admin stays "on-prem only" by
  network topology for now — MVP does not need network-level access
  control on it yet (that's a Stage 6 hardening item), but don't link
  to it from the public-facing pages.
- **No frontend framework.** Plain HTML/CSS/JS, no build step. Keeps
  Claude Code iteration fast and there's nothing to harden later that
  isn't already just static files.

### Studio deployment (Architecture 1)

The Studio PC needs a browser and nothing else — no install, no
platform-specific code, matching the "as little configuration as
possible" / platform-agnostic requirement (Windows or Linux, any
modern browser).

Two consequences of moving studio audio off the Local Server:

1. **getUserMedia needs a secure context**, and the Studio PC is no
   longer `localhost` relative to the Local Server. For dev/test, use
   the least-friction option — launch the Studio PC's browser in
   kiosk mode with a flag like
   `--unsafely-treat-insecure-origin-as-secure=http://<local-server-lan-ip>:3000`
   pointed at the Local Server's LAN URL. This is a deliberate,
   temporary shortcut (least security necessary for dev/test) — swap
   for real TLS (mkcert, or Caddy once Stage 5 stands up a real
   domain) before this leaves a controlled dev/test setting.
2. **Device selection matters now.** The Studio PC will have more than
   one audio device (built-in + the real line-level interface), so
   `/studio` needs an input/output device picker
   (`enumerateDevices()`, plus `setSinkId()` for output routing where
   supported — Chromium yes, Firefox no as of writing; worth knowing
   if the Studio PC might run Firefox).

**Considered, not built: cloud-hosted Local Server ("Architecture
2").** Same app code, different deployment target — Local Server on a
public cloud VM instead of on-prem, with client and studio both
reaching it over the internet. Deferred for now; revisit if on-prem
hosting becomes impractical. If it comes back: `/admin` auth can no
longer rely on network topology and needs a real gate sooner than
Stage 5, and round-trip latency needs re-validating since both client
and studio would take a WAN hop instead of one.

## Stack

- **OS**: Ubuntu Linux (currently a VirtualBox VM on a Windows 11 host
  during dev — see Dev Environment below; production may move to bare
  metal later, no software changes required to do so).
- **Backend**: Node.js + Express, `ws` for WebSocket signaling.
- **TURN/STUN**: coturn.
- **TLS (Stage 5+ only)**: Caddy, serving on a non-standard external
  port (52001) rather than 80/443 — deliberate choice to keep the
  well-known web ports closed to the internet (reduces automated
  scanner noise; doesn't hide the domain itself, since any public cert
  is logged in Certificate Transparency regardless of port — real
  access control is still Stage 6). Cert obtained manually via
  certbot's DNS-01 challenge (no inbound port needed for issuance,
  unlike HTTP-01/TLS-ALPN-01) rather than Caddy's automatic HTTPS —
  trades one-time plugin/API-token setup for a recurring manual
  renewal step (~every 60 days, see infra/README.md). Not needed for
  LAN dev.
- **Dev-only secure context**: mkcert, for LAN testing without a
  domain (getUserMedia requires a secure context; a bare LAN IP over
  HTTP does not qualify).

## Dev environment

- Local Server = Ubuntu VM under VirtualBox on a Windows 11 host,
  developed on directly via Claude Code running in the VM.
- Continuing to develop primarily on this one VM for as long as
  practical — simulate the Studio PC with a second browser
  tab/profile on the same box rather than provisioning a real second
  machine before it's needed.
- **Known caveat**: same-VM testing (client tab + studio tab + Node +
  coturn all sharing one VM's CPU and virtualized network/audio
  stack) measurably inflates latency and isn't representative of the
  real deployment. Don't chase VM-induced latency — see the Stage 1
  gate note below; the real latency checkpoint is Stage 2, once the
  Studio PC is a genuinely separate machine.
- VM networking: **Bridged Adapter** (not NAT) — VM needs its own LAN
  IP so phones/laptops can reach it during testing.
- USB audio interface passthrough is **no longer needed** for the
  Local Server now that studio audio moves to its own PC (see
  Architecture decisions). If the Studio PC's *own* audio latency
  looks off once it's real hardware, the fallback there is the same
  as before: bare metal instead of a VM.

## Stages and gates (work through these in order — don't jump ahead)

0. **Infra** — done. Ubuntu VM up, Node installed, coturn installed
   and passing a trickle-ICE test.
1. **Signaling + loopback WebRTC** — done, with a caveat. Two browser
   tabs on the same VM exchange audio via the server, relayed through
   coturn.
   Gate (informal, same-VM): audio flows tab-to-tab.
   ⚠ Measured round-trip latency here is well over the <100ms target,
   but that's expected — client, studio, Node, and coturn all
   currently share one VM's CPU and virtualized network/audio stack,
   which isn't representative of the real deployment. Not
   investigating further at this stage; see Stage 2.
2. **Studio on its own endpoint** — done, with a caveat (replaces the
   old "VM USB passthrough" plan — see Architecture decisions). Device
   picker (input/output, `setSinkId` where supported) and the dev-only
   insecure-origin flag are both implemented. Verified by running
   `/client` and `/studio` in a Chrome instance on the VM's Windows
   host (a genuinely separate machine from the Local Server/VM),
   relayed through the real deployed coturn — connects cleanly, device
   lists populate with real device names, and round-trip time is now
   shown live (`getStats()` polling) instead of relying on ear-judgment.
   Gate (interim): round-trip time dropped noticeably once the
   client/studio browsers moved off the VM, confirming the Stage 1
   latency note — subjectively "good enough for a live link," though
   not confirmed strictly under 100ms one-way.
   ⚠ Not yet validated: a genuinely *separate* Studio PC (client and
   studio both ran on the same Windows host this round, standing in
   for two machines) and a real physical line-level interface (host's
   built-in mic/speakers stood in for it). Revisit when real studio
   hardware is available — not blocking further stages.
   ⚠ **To investigate later**: the displayed RTT reads single-digit ms,
   but audible delay on the host test was noticeably longer than that.
   RTT is transport-only (see the code comment in webrtc-link.js) — the
   gap is most likely WebRTC's adaptive jitter buffer plus OS-level
   audio capture/render latency on both ends, neither of which the
   transport RTT stat captures. Not investigated yet; worth digging
   into once real studio hardware is in the loop (Opus frame size,
   jitter buffer target, audio driver buffer sizes).
   ⚠ **Not investigating further for now**: a quick Stop-then-Start
   (within ~5s) on the client can show `connected` with no audible
   audio. No code-level timeout causes this. Best guess: studio's
   kiosk auto-rearm restarts audio capture on almost the same physical
   device at almost the same moment as the client's own restart,
   hitting an OS/driver-level settling delay on reacquisition — same
   root cause as the not-yet-validated line above (client and studio
   still share one host's audio hardware). Tried staggering studio's
   auto-rearm by 1s as a mitigation; that made the required gap
   *longer*, not shorter, so it was reverted. Considered far enough
   from the real deployment (dedicated hardware per side) not to be
   worth chasing further right now — revisit once client and studio
   are on genuinely separate machines.
3. **Session logic** — done. Server tracks peer roles via a `hello`
   message, enforces single-active-session exclusivity (a second
   client's offer is rejected with `busy` instead of relayed), and a
   configurable `SESSION_TIMEOUT_MINUTES` (default 60) force-ends a
   session nobody stopped manually. Either side disconnecting also
   ends the session immediately (no waiting on ICE-level timeout).
   Studio auto-rearms after the client hangs up or times out
   (kiosk-style — no operator action needed for the next caller), but
   stays stopped after a deliberate Stop click.
   Gate: confirmed — a second client is rejected (both a soft
   client-side "busy" pre-check and a hard server-side rejection tested
   directly) while a session is live, and an isolated short-timeout run
   confirmed auto-termination plus studio re-arm, all with no console
   errors.
4. **Admin UI** — done. `/admin` (not linked from `/client` or
   `/studio`) shows link availability and session status (with elapsed
   time), with buttons to toggle availability and force-terminate a
   live session. No auth yet — same "on-prem only by network topology"
   reasoning as before; real access control is still Stage 6.
   Disabling rejects new offers server-side with a distinct
   `unavailable` message (separate from `busy`); force-terminate
   reuses the existing session-end path with reason `admin-terminated`,
   so studio's kiosk auto-rearm (now "any reason except a manual Stop
   click") kicks in the same as a normal hangup or timeout.
   Gate: confirmed — toggling disable is enforced both client-side
   (preflight poll) and with a hard server-side rejection test (studio
   never received the offer at all while disabled), and force-terminate
   ends a live session, shows "ended by admin" on the client, and
   studio re-arms — all with no console errors.
5. **Field test** — done, with a caveat. Domain `audiolink.example.com`
   live via Caddy on a non-standard port (52001, not 80/443 — see
   "Stack" and `infra/README.md` for why), cert obtained via certbot's
   manual DNS-01 challenge, coturn's `external-ip` fix confirmed
   necessary for a real external client to relay audio at all. Studio's
   insecure-origin dev flag retired in favor of the real cert.
   Gate (interim): confirmed — a real client on mobile data connects to
   `https://audiolink.example.com:52001/client` and holds a link with
   studio over the real WAN path.
   ⚠ Not yet rigorously checked: actual latency and audio quality under
   real mobile-data conditions (the <100ms / broadcast-acceptable NFRs)
   — confirmed connectivity, not measured quality. Revisit before
   calling this NFR gate fully met.
   ⚠ Still deferred from Stage 2: swapping the raw connection-state
   status text (e.g. "waiting for answer...") for non-technical-user
   wording. Not done yet — carry forward.
6. **Hardening** — done. Node's `app.listen()` is localhost-only
   (Caddy is the sole reachable entry point, LAN or otherwise); `/admin`
   and `/api/admin/*` were gated with HTTP Basic Auth in Caddy (since
   superseded by a real login — see "Multi-link capability" below); a
   small hand-rolled in-memory rate limiter (no new dependency) caps all
   `/api/*` routes at 120 req/min/IP; and fail2ban watches Caddy's
   access log, banning an IP for 1 hour after 5 failed `/admin` logins
   in 10 minutes. See infra/README.md's "Hardening" section for the
   full deploy sequence.
   Gate: confirmed — LAN-direct access to the app now fails to connect,
   `/admin` returns 401 for no/wrong credentials and 200 for the right
   ones, and `/client`/`/studio`/the public API routes are unaffected.

All 6 originally-staged items are now done, each with caveats already
noted above rather than silently dropped. What's left before calling
this genuinely finished:
- Stage 2: a real, separate Studio PC and physical line-level interface
  (still simulated via the VM's Windows host).
- Stage 2/5: the RTT-vs-perceived-delay gap and the Stop/Start
  audio-cooldown quirk — both tied to the same not-yet-separate-hardware
  caveat above.
- Stage 5: rigorous latency/audio-quality measurement under real
  mobile-data conditions (connectivity confirmed, NFR numbers not).
- Stage 2 (deferred to Stage 5, still not done): friendly status
  wording for non-technical users.

**Current stage: all 6 staged. Remaining work is the carried-forward
items above, most gated on real studio hardware.**

## Multi-link capability (new initiative, on `feature/multi-link`)

Extends the MVP from one global studio/session to multiple independent
studios, each activating shareable, named "Links" on demand. Full
requirements: see the multi-link requirements doc (docx, not in this
repo) — key model: a Link is created by a Studio or Admin operator
(unique name, unguessable token/URL), sits unclaimed until *some*
Studio browser activates it (binding it to that browser until stopped
or closed), and only then can a Client using that Link's URL connect.
Exclusivity, timeout, and auto-rearm all still apply, just scoped
per-Link instead of globally. Being built on a feature branch since
Stage 3 rewrites the exact session/relay model everything else (Stages
0-6 above) was built around — see PLAN (this section) for the staged
breakdown; not merging to `master` until it's genuinely done.

1. **Auth foundation** — done. Real login (session cookie) for
   `/studio` and `/admin`, replacing Caddy's Basic Auth — needed first
   since "operator logged in" is load-bearing for everything after it,
   and Basic Auth had no clean logout. Two fixed accounts (`studio`,
   `admin` — same shared-credential model as before, not per-operator),
   scrypt-hashed passwords via Node's built-in `crypto` (no new
   dependency), `HttpOnly`/`Secure`/`SameSite=Lax` cookie, in-memory
   session store (fine to lose on restart — unlike the Links registry
   coming in Stage 2, which won't be). `admin` outranks `studio` in a
   simple role hierarchy. `/client` and the shared APIs
   (`/api/session`, `/api/ice-config`, `/signal`) stay fully
   unauthenticated — reporters never log in.
   Gate: confirmed — `/studio` and `/admin` redirect to `/login` when
   logged out; wrong credentials 401; a `studio` login reaches
   `/studio` but gets 401 from `/api/admin/*`; `admin` reaches both;
   Logout genuinely invalidates the session server-side, not just a
   client-side redirect (re-requesting the page after logout bounces
   back to `/login`).
2. **Link registry** — done. A Link is `{ id (crypto.randomUUID(),
   doubles as its URL token), name, createdAt }`, persisted to
   `server/data/links.json` (plain JSON file, gitignored — no database
   at this scale) so it survives a restart. Hard-deleted, not
   soft-deleted: a removed Link has to fail lookup exactly like one
   that never existed, so there's no "deleted" state to leak through.
   `GET`/`POST /api/links` and `DELETE /api/links/:id` require the
   `studio` role; `GET /api/links/:id` is deliberately public (the
   Client needs to look up its Link without logging in) and returns an
   identical generic 404 for malformed/deleted/never-existent ids — no
   distinguishing info leaked, and it's already behind the Stage 6 rate
   limiter regardless. `GET /client/:id` now falls through to serve the
   client page (previously only exact static files under `/client`
   matched), so a Link's generated URL actually loads something — but
   `client.js` doesn't use the id for anything yet; that's Stage 3.
   Not wired to the WebRTC/session logic at all yet — creating a Link
   is currently inert with respect to actual calls.
   Gate: confirmed — full CRUD cycle, case-insensitive name uniqueness
   (and reuse after delete), auth enforced on create/delete/list but
   not the public lookup, persistence survives an actual server
   restart, and a well-formed-but-unknown id returns the same 404 as a
   malformed one.
3. **Per-link signaling rewrite** — done. The core architecture change:
   `liveLinks: Map<linkId, {studioWs, clientWs, startedAt,
   timeoutHandle}>` replaces the single global `activeSession`; `relay()`
   routes addressed to the sender's specific Link pair instead of
   broadcasting to every connected peer. `hello` now carries `linkId`
   for both roles — for a Studio (answerer), `hello` doubles as its
   attempt to claim that Link (accepted -> `activated` + notifies any
   client already waiting; rejected -> `link-not-found` /
   `unavailable` / `link-claimed` if a different open Studio connection
   already holds it). A Link is fully released whenever its session
   ends for any reason — studio.js's existing kiosk auto-rearm
   (unchanged) immediately reclaims it via a fresh connection, so the
   gap is negligible and it's usually the same browser winning the
   race back, matching "available to any browser" in the requirements
   doc. `webrtc-link.js`'s answerer role now gates on an explicit
   activate accept/reject (`waitForActivation()`) rather than assuming
   `hello` always succeeds; studio.js's auto-rearm condition became an
   explicit `AUTO_REARM_REASONS` allowlist (`timeout`, `peer-ended`)
   instead of an "anything but manual" blocklist, since a rejected
   activation is also a non-manual stop and retrying an already-failed
   claim in a loop would be wrong — `admin-terminated` was initially
   included too but removed once Stage 4 testing showed it made Force
   Terminate look broken (the Link reclaimed itself so fast it never
   visibly went idle); a moderation action should behave like the
   operator's own Stop, not like a normal call ending. `/api/session` and
   `/api/admin/terminate` (both global, meaningless once sessions are
   per-Link) replaced with `/api/status`, `/api/links/:id/status`, and
   `/api/admin/links/:id/terminate`.
   UI was extended only to the functional minimum needed to actually
   exercise this (full polish is Stage 4): client.js reads its Link id
   from the URL and shows its name; studio.js shows a fetched list of
   Links with one Start button each instead of one global button;
   admin.js shows the same kind of list with Force Terminate each,
   replacing the now-meaningless single global session display.
   Gate: confirmed extensively with two Links live concurrently — full
   isolation (neither Link's SDP/ICE ever reaches the other's peers,
   both stay connected simultaneously), Studio-side exclusivity (a
   third browser rejected without disturbing the live call),
   Client-side busy (per-Link), admin force-terminate scoped to exactly
   one Link (studio auto-rearms, the other Link untouched), a bogus
   Link id failing safely, and global disable blocking new activity
   while an already-live call keeps running — zero console errors
   across every tab throughout.
4. **UI** — done. Studio and Admin both show a real Links table (name,
   created date/time, live status, shareable URL with Copy, actions)
   plus a create-link form, via a shared `shared/link-manage.js`
   (date/status formatting, copy-URL button, delete button, create-form
   wiring) rather than duplicated per page. `GET /api/links` now
   reports each Link's live status (`idle`/`armed`/`connected`, with
   elapsed time once connected) by cross-referencing `liveLinks`, not
   just static registry data. Studio's per-row action button is
   context-sensitive (Start when idle, Stop when this browser is the
   one on that Link) instead of a separate global Stop button. Client's
   wait status now reads "waiting for studio, please try again
   shortly..." per the requirements doc's suggested wording (still
   auto-connects the instant Studio activates — no retry actually
   needed, just the wording asked for).
   Also closed a real gap found while building this: `DELETE
   /api/links/:id` now rejects (409) deleting a Link that's currently
   armed or live, both client-side (button disabled) and server-side
   (the actual guard) — deleting a live Link would have orphaned it
   from the registry, so a later auto-rearm attempt would fail with
   `link-not-found` instead of quietly going idle.
   Gate: confirmed — full create/list/delete cycle in both UIs, live
   status matches between Studio and Admin and updates correctly
   through a full start/connect/stop/auto-rearm cycle, the delete guard
   rejects both client- and server-side while armed or live, and the
   new wait-for-studio wording displays correctly — no console errors
   beyond an expected sandboxed-browser Clipboard permission block that
   the Copy URL button already catches gracefully.
5. **Audit logging + quality-problem detection** — done. `server/
   audit-log.js` appends newline-delimited JSON to `server/data/
   activity.log` (gitignored, no database — "a running log of
   individual events is acceptable" per the requirements doc). Five
   event types: `link-created`/`link-deleted` (from the `/api/links`
   routes), `link-started`/`link-stopped` (from the signaling layer —
   only when a call actually connected, not for a Link merely armed
   then released), and `quality-problem`.
   Quality detection has to happen in the browser — the server never
   sees actual media (relayed via TURN, never proxied through the
   app). Extends `webrtc-link.js`'s existing RTT-only stats polling to
   also read inbound-rtp jitter/packetsLost/packetsReceived against
   unvalidated default thresholds (300ms RTT, 100ms jitter, 5% packet
   loss — nothing in the requirements doc specifies exact numbers) and
   watches `connectionstatechange` for disconnected/failed, debounced
   to log once per episode via the new public `POST /api/links/:id/
   quality-event` (client and studio both report their own connection,
   so it can't require login; detail is server-truncated to 200
   chars). Admin gets a read-only "Recent Activity" table (`GET
   /api/admin/activity`) — deliberately just a log tail, not a
   queryable dashboard, matching the doc's framing.
   Gate: confirmed via the real API and UI — all five event types log
   correctly through a full create/arm/connect/stop/delete cycle, the
   quality-event endpoint's 404 and truncation both work, and Admin's
   table renders everything newest-first. The client-side thresholds
   are code-reviewed against the standard WebRTC stats fields and
   confirmed to run error-free during a live connection, but forcing
   an actual threshold crossing (real packet loss/jitter) wasn't
   practical to verify in this environment — worth a spot-check once
   real degraded network conditions exist to test against.
6. **Hardening pass** on the new endpoints — done. Audited every
   multi-link route against the original MVP's four hardening pillars
   (localhost-only bind, auth, rate limiting, fail2ban) and found them
   already correctly applied to every new route with no gaps: `studio`/
   `admin` role checks are on the right endpoints, the generic 120/min/IP
   `/api/*` limiter already covers login and all new routes uniformly,
   and the existing fail2ban filter — which matches any 401 in Caddy's
   log regardless of path, not just `/admin` specifically — already
   catches repeated failed `POST /api/login` attempts for free (updated
   its comments to say so explicitly rather than renaming the
   already-deployed filter/jail files, avoiding a redeploy for a purely
   cosmetic rename). Two concrete gaps found and fixed: Link names had
   no length cap (added a 100-char max in `links.js`, matching the
   existing 200-char cap on quality-event's `detail`); and the public,
   unauthenticated `POST /api/links/:id/quality-event` would log a
   free-text entry for any valid-but-idle Link id, letting anyone who
   knows a Link's URL spam the audit log indefinitely with no call ever
   live — now silently accepted (still 204, no liveness info leaked
   beyond what `/api/links/:id/status` already exposes) but only
   actually logged while `liveLinks.has(id)`. Also confirmed the
   `SameSite=Lax` cookie from Stage 1 still provides adequate CSRF
   protection for the new state-changing routes (link create/delete,
   admin enable/terminate) — a cross-site POST can't carry it.
   Gate: confirmed — direct `links.js` test shows a 100-char name
   accepted and 101 rejected; over HTTP, `POST /api/links` returns the
   same rejection; a real WebSocket studio+client handshake armed a
   test Link live, and `quality-event` posted against it while idle
   returned 204 with no audit-log write, then returned 204 *with* a
   write once the same Link was actually live — both halves verified
   against the live activity.log, not just code review.

## Post-launch follow-ups (after all 6 multi-link stages)

Ad hoc requests after the staged plan above was fully done, not part of
either the original MVP or multi-link stage breakdown:

- **UI redesign** — dark theme (page background matched exactly to the
  audiolink logo's own background color), the logo (wordmark included) in
  a shared header, colored status-badge pills instead of plain status
  text, and controls grouped into per-panel cards. See
  `server/public/shared/style.css`, `shared/header.js`.
- **Node app as a systemd service** — `infra/audiolink.service`
  replaces manually starting `node --env-file=.env index.js` in a
  terminal, so the app survives a VM reboot. See infra/README.md's "Node
  app as a systemd service" section for the deploy step (needs `sudo`, so
  it's a step to run by hand, same as Caddy/coturn/fail2ban before it).
- **Admin can change both passwords** — a "Change Password" panel on
  `/admin` (not `/studio` — Studio has no password-management UI) for
  either fixed account. `server/auth.js`'s `passwordComplexityError()`
  enforces at least 12 characters plus one of each character class
  (upper/lower/digit/symbol); `POST /api/admin/password` takes effect
  immediately (`auth.setPasswordHash`) without touching existing sessions
  for that role (an operator mid-broadcast doesn't get logged out just
  because their password changed), and persists the new hash to
  `server/.env` via the new `server/env-file.js` so it survives a restart.
- **Recent Activity pagination + date range** — 20 events/page (fixed),
  plus an optional `from`/`to` filter (datetime-local inputs, converted to
  epoch ms client-side). `audit-log.js`'s `readRecent(limit)` became
  `readEvents({from, to})` since a range filter has to scan the *whole*
  log, not just a recent tail — capping first would make an older range
  silently return nothing once the log outgrows the old cap.
- **Admin's Disable Link now confirms** — re-enabling stays a single
  click (safe/restorative); disabling (blocks every Link for every
  caller) needs a confirm() first.
- **Studio wording** — "Answer incoming Links..." → "Start incoming
  Links...", and the answerer's in-flight "waiting for offer..." status →
  "waiting for client...".

Gate: confirmed for all of the above — verified over real HTTP/WebSocket
(not just code review): password complexity rejections for each missing
character class, a successful change immediately persisted to `.env` and
usable for login pre-restart while the *other* role's line was left
untouched, `/api/admin/activity` pagination (50 test events → page 1/2 of
3, 20 each) and an impossible date range correctly returning zero, and the
Disable Link confirm() both blocking on cancel and proceeding on accept.
Not yet confirmed: the systemd service itself (drafted and documented,
but installing/enabling it needs `sudo`, which this session can't run
non-interactively — the user needs to run the deploy commands and reboot
to verify it survives).

- **Cloudflare-proxied deployment mode, as an alternative to the
  non-standard-port setup.** The user wanted to hide the origin's real IP
  by proxying through Cloudflare's free plan. That's only possible for the
  web app/signaling — genuinely not possible for TURN, on any Cloudflare
  plan short of the paid Spectrum product, because no browser's WebRTC
  ICE implementation supports tunneling TURN through an HTTP(S)/WebSocket
  transport; TURN's real IP is unavoidably exposed to both call
  participants regardless. Implemented as **two parallel Caddyfile
  templates** (`infra/Caddyfile.cloudflare`, `infra/Caddyfile.direct`)
  rather than one parameterized file, since the two modes differ
  structurally (global `trusted_proxies`/`auto_https off` block, bare
  vs. `:port` site address) more than they share. `infra/install.sh`
  now prompts for deployment mode up front and branches accordingly:
  external port (fixed 443 vs. asking, defaulting 52001), the TURN
  hostname (`turn.$DOMAIN`, kept unproxied, vs. sharing `$DOMAIN`
  directly), which Caddyfile template to deploy, and a Caddy-version
  guard (`trusted_proxies` needs 2.7+, which Ubuntu's own `apt` package
  can lag well behind — install.sh already pulls from Caddy's official
  repo, so this only bites an existing pre-`install.sh` Caddy install,
  which is exactly what happened on the real deployment this was
  developed against). `docs/security-overview.md` and `README.md`
  updated to describe both modes side by side rather than assuming one.
  Gate: confirmed on the real deployment (not just the installer script)
  — Caddy upgraded 2.6.2 → 2.11.4, DNS split correctly (main hostname
  resolving to Cloudflare edge IPs, `turn.` subdomain resolving directly
  to the real origin IP), `TURN_URI` repointed and a call still connects,
  and — the part most likely to silently break — a live Caddy access-log
  entry confirmed `trusted_proxies` actually resolves the real visitor IP
  (`client_ip`) separately from Cloudflare's edge IP (`remote_ip`), not
  just that the site loads.

### Deferred

- **Auto-populate Studio/Client device pickers on page load** — considered,
  not implemented. Starting a call already defaults to the OS default
  device with zero setup either way (`getUserMedia` with no `deviceId`
  constraint), so this is a discoverability/cosmetic improvement, not a
  functional gap. The safe version is enumerate-only on load (bare
  `enumerateDevices()`, no `getUserMedia` call) — never prompts, shows
  real device names if the origin already has a persisted mic grant
  (true for Studio's kiosk profile after first setup), generic fallback
  names otherwise. Deliberately rejected the alternative of auto-running
  the existing unlock-then-enumerate flow on load: that means firing the
  mic permission dialog the instant the page loads, before the user's
  done anything — risky for Client especially (opened cold, often via a
  messaging app's in-app browser/webview, which are inconsistent about
  permissions not tied to a direct tap) since a reflexive "Block" is much
  harder to recover from than just not clicking a button. Revisit if
  device-picker friction actually becomes a reported problem in the field.
## Conventions

- Keep commits scoped to one stage/gate where possible.
- Don't add a frontend build step, a frontend framework, or a
  server-side WebRTC media engine — these are considered out of scope
  unless the requirements doc changes.
- Prefer Node's built-in modules and the small dependency set above
  over adding new libraries; this is a small, hardenable-later system,
  not a place to accumulate a large dependency tree.

# audiolink — Requirements

## Purpose
Two-way real-time audio link between a radio studio ("On Prem") and a
client in the field, over the public internet. Typical use: remote
reporter on a 5G connection doing a live cross, remote interviews,
talkback during an event.

## Actors
- **Client Browser** — runs on the reporter's phone/tablet/PC/laptop.
  Nothing installed beyond a standard web browser (e.g. Chrome).
- **Local Server** — repurposed PC (or VM) on prem. Hosts the web
  application (signaling + relay) that Client Browser and Studio PC
  both connect through. Does not itself handle studio audio.
- **Studio PC** — a separate on-prem PC (Windows or Linux), with a
  built-in/USB audio card wired into the radio studio's line-level
  I/O. Runs nothing beyond a standard web browser pointed at the Local
  Server — same "nothing installed" bar as the Client Browser.
- **Radio Studio** — receives/sends line-level audio from/to the
  Studio PC. Already wired; out of scope for this project.

## Functional requirements
- Local Server hosts a web application that both the Client Browser
  and the Studio PC connect to.
- Client Browser takes audio input from whatever local device is
  currently providing input (mic or line level) and sends it, via the
  Local Server, to the Studio PC, which outputs it to the studio.
- Studio PC takes line-level audio input from the studio and sends it,
  via the Local Server, to the Client Browser, which outputs it to
  whatever local device is providing output on the client device.
- Client Browser initiates and terminates the link via a UI with
  start/stop controls.
- While a link is live, the web app shows session status and rejects
  any other browser attempting to start a second link (single active
  session only).
- A separate on-prem-only admin UI allows a local user to:
  - enable/disable client-initiated links,
  - force-terminate an active link.
- Configurable timeout auto-terminates a link if the client doesn't
  stop it manually.

## Non-functional requirements
- Audio quality: broadcast-acceptable for speech.
- Latency: < 100 ms one-way, either direction.
- Bitrate: as low as practical, given clients may be on mobile data.
- Nothing beyond a browser required on the client device.
- Studio PC requires as little configuration as possible beyond
  ensuring its audio interface is available to the browser — no
  custom install, works on Windows or Linux.
- Client device manages its own internet connectivity (out of scope).

## Deferred (post-MVP)
- Hardening for public-internet exposure: TLS enforcement, auth,
  rate limiting, intrusion protection (fail2ban or equivalent), etc.
  Explicitly out of scope until the MVP works end-to-end.
- **Combined Local Server + studio audio interface** (the original
  architecture: one on-prem machine hosts both the web application and
  the line-level audio hardware directly, with no separate Studio PC).
  Superseded for now by the Local Server/Studio PC split above, but
  worth keeping in mind: a fixed, station-wide audio source wired
  directly into the server infrastructure, controllable from anywhere,
  has real value over depending on a separate PC being present,
  powered on, and correctly configured. Revisit once the Local
  Server/Studio PC split is proven out.

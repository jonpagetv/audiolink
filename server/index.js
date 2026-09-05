const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { ROLE_RANK, createAuth, parseCookies, hashPassword, passwordComplexityError } = require('./auth');
const { createLinkRegistry } = require('./links');
const { logEvent, readEvents } = require('./audit-log');
const { setEnvValue } = require('./env-file');

const PORT = process.env.PORT || 3000;
const TURN_URI = process.env.TURN_URI;
const TURN_SECRET = process.env.TURN_SECRET;
const TURN_CRED_TTL_SECONDS = Number(process.env.TURN_CRED_TTL_SECONDS || 3600);
const SESSION_TIMEOUT_MS = Number(process.env.SESSION_TIMEOUT_MINUTES || 60) * 60 * 1000;
const AUTH_SESSION_HOURS = Number(process.env.AUTH_SESSION_HOURS || 12);
const AUTH_COOKIE = 'wal_session';
const ENV_FILE = path.join(__dirname, '.env');

const auth = createAuth({
  studioPasswordHash: process.env.STUDIO_PASSWORD_HASH,
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH,
  sessionHours: AUTH_SESSION_HOURS,
});

function getAuthSession(req) {
  return auth.getSession(parseCookies(req.headers.cookie)[AUTH_COOKIE]);
}

const linkRegistry = createLinkRegistry();

// Studio and Admin both require login now (real sessions, not Caddy Basic
// Auth — that had no clean logout). A GET for a page redirects to /login
// (no ?next= — login.js sends the user to /studio or /admin based on the
// role they log in as, since each role has exactly one home page); anything
// else (API calls) gets a plain 401, since there's no page to redirect an
// XHR/fetch to.
function requireAuth(minRole) {
  return (req, res, next) => {
    const session = getAuthSession(req);
    if (!session || ROLE_RANK[session.role] < ROLE_RANK[minRole]) {
      if (req.method === 'GET' && req.accepts('html')) {
        res.redirect('/login');
      } else {
        res.status(401).json({ error: 'unauthorized' });
      }
      return;
    }
    next();
  };
}

const app = express();
app.use(express.json());
// Caddy is a reverse proxy on the same host (loopback) — trust its
// X-Forwarded-For so req.ip is the real client IP, not Caddy's, for
// rate limiting below.
app.set('trust proxy', 'loopback');

// Small in-memory fixed-window limiter — no new dependency, matching the
// project's existing "small dependency set" convention. Per-IP, applied to
// all /api/* routes: generous enough for normal polling (client/studio
// check /api/session every 5s) while capping scripted abuse of TURN
// credential minting or the admin endpoints.
function rateLimit({ windowMs, max }) {
  const hits = new Map(); // ip -> { count, resetAt }
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) {
      if (now > entry.resetAt) hits.delete(ip);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    const entry = hits.get(req.ip);
    if (!entry || now > entry.resetAt) {
      hits.set(req.ip, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    if (entry.count >= max) {
      res.status(429).json({ error: 'too many requests' });
      return;
    }
    entry.count += 1;
    next();
  };
}

app.use('/api', rateLimit({ windowMs: 60_000, max: 120 }));

app.use('/shared', express.static(path.join(__dirname, 'public/shared')));
app.use('/client', express.static(path.join(__dirname, 'public/client')));
// A Link's shareable URL is /client/<id> — falls through to here (the
// static mount above only matches real files) and serves the same page.
// client.js doesn't yet do anything with the id (that's the multi-link
// Stage 3 signaling rewrite) — for now this just means a generated URL
// actually loads something instead of 404ing.
app.get('/client/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/client/index.html'));
});
app.use('/login', express.static(path.join(__dirname, 'public/login')));
app.use('/studio', requireAuth('studio'), express.static(path.join(__dirname, 'public/studio')));
// Not linked from /client or /studio.
app.use('/admin', requireAuth('admin'), express.static(path.join(__dirname, 'public/admin')));

app.get('/', (req, res) => {
  res.type('text/plain').send('audiolink server\n\n/client - reporter UI\n/studio - on-prem UI\n');
});

// Short-lived TURN credentials via coturn's REST API mechanism (a shared
// secret HMACs a username/timestamp — see infra/turnserver.conf). Keeps the
// long-lived secret server-side instead of baking it into static JS.
function generateTurnCredentials(secret, ttlSeconds) {
  const username = String(Math.floor(Date.now() / 1000) + ttlSeconds);
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

app.get('/api/ice-config', (req, res) => {
  if (!TURN_URI || !TURN_SECRET) {
    res.status(500).json({ error: 'TURN not configured; set TURN_URI and TURN_SECRET (see server/.env.example)' });
    return;
  }

  const { username, credential } = generateTurnCredentials(TURN_SECRET, TURN_CRED_TTL_SECONDS);

  res.json({
    // Both peers relay through the single coturn port — no direct P2P path.
    iceTransportPolicy: 'relay',
    iceServers: [
      {
        urls: [`${TURN_URI}?transport=udp`, `${TURN_URI}?transport=tcp`],
        username,
        credential,
      },
    ],
  });
});

// Global kill switch only — per-link status is /api/links/:id/status below.
app.get('/api/status', (req, res) => {
  res.json({ enabled: linkEnabled });
});

// Link registry (multi-link Stage 2), now wired to the per-link signaling
// below (Stage 3).
function buildClientUrl(req, id) {
  return `${req.protocol}://${req.get('host')}/client/${id}`;
}

// 'idle' (no Studio armed), 'armed' (a Studio is waiting for a caller), or
// 'connected' (a call is actually live) — the Studio/Admin list views need
// this to show real status, per the requirements doc.
function linkStatus(id) {
  const live = liveLinks.get(id);
  if (!live) return { status: 'idle' };
  if (!live.clientWs) return { status: 'armed' };
  return { status: 'connected', startedAt: live.startedAt };
}

app.get('/api/links', requireAuth('studio'), (req, res) => {
  const links = linkRegistry
    .list()
    .map((link) => ({ ...link, url: buildClientUrl(req, link.id), ...linkStatus(link.id) }));
  res.json({ links });
});

app.post('/api/links', requireAuth('studio'), (req, res) => {
  const result = linkRegistry.create(req.body?.name);
  if (result.error) {
    res.status(400).json({ error: result.error });
    return;
  }
  logEvent('link-created', { linkId: result.link.id, name: result.link.name });
  res.status(201).json({ link: { ...result.link, url: buildClientUrl(req, result.link.id), status: 'idle' } });
});

app.delete('/api/links/:id', requireAuth('studio'), (req, res) => {
  // Deleting a live Link would orphan it from the registry — the call
  // keeps running, but a later auto-rearm attempt would fail with
  // link-not-found instead of quietly going idle. Stop or force-terminate
  // it first.
  if (liveLinks.has(req.params.id)) {
    res.status(409).json({ error: 'link is currently armed or live' });
    return;
  }
  const link = linkRegistry.get(req.params.id);
  const removed = linkRegistry.remove(req.params.id);
  if (removed) logEvent('link-deleted', { linkId: req.params.id, name: link.name });
  res.status(removed ? 200 : 404).json({ removed });
});

// Public — the Client page uses this to look up its Link. A bad, deleted,
// or never-existent id all get the identical generic 404: the requirement
// is that stale/guessed URLs fail the same safe way regardless of why.
app.get('/api/links/:id', (req, res) => {
  const link = linkRegistry.get(req.params.id);
  if (!link) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ id: link.id, name: link.name });
});

// Public — the Client's preflight poll (busy/disabled check) for its own
// Link specifically, not global system state.
app.get('/api/links/:id/status', (req, res) => {
  const live = liveLinks.get(req.params.id);
  res.json({
    active: Boolean(live?.clientWs),
    enabled: linkEnabled,
  });
});

// Public — client.js and studio.js both report their own connection's
// quality problems here (high RTT/jitter/packet-loss, or the ICE
// connection dropping), since the server has no visibility into actual
// media flow itself (it's relayed via TURN, never proxied through this
// app). Detail is free text from the browser, so keep it bounded.
//
// Only actually written to the audit log if the Link is currently live
// (Stage 6 hardening): this is the one unauthenticated endpoint that
// *writes*, and a Link's UUID, once known (e.g. shared as its own call
// URL), would otherwise let anyone spam arbitrary free-text log entries
// for it indefinitely, live call or not. Silently accepting-but-dropping
// (still 204) rather than 404/409 avoids exposing liveness to a caller
// who doesn't already know it some other way — though that information
// is already public via /api/links/:id/status regardless.
app.post('/api/links/:id/quality-event', (req, res) => {
  const link = linkRegistry.get(req.params.id);
  if (!link) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (liveLinks.has(link.id)) {
    const detail = String(req.body?.detail || '').slice(0, 200);
    logEvent('quality-problem', { linkId: link.id, name: link.name, detail });
  }
  res.status(204).end();
});

// Admin-only activity log view, paginated (20/page, fixed) with an
// optional [from, to] epoch-ms range — admin.js converts its datetime-local
// inputs to epoch ms client-side before sending. Filtering has to scan the
// full log (not just a recent tail): an older range would silently come up
// empty if this only ever looked at the last N lines.
const ACTIVITY_PAGE_SIZE = 20;

app.get('/api/admin/activity', requireAuth('admin'), (req, res) => {
  const from = req.query.from ? Number(req.query.from) : null;
  const to = req.query.to ? Number(req.query.to) : null;
  const page = Math.max(1, Number(req.query.page) || 1);

  const matching = readEvents({ from, to });
  const start = (page - 1) * ACTIVITY_PAGE_SIZE;
  res.json({
    events: matching.slice(start, start + ACTIVITY_PAGE_SIZE),
    total: matching.length,
    page,
    pageSize: ACTIVITY_PAGE_SIZE,
  });
});

// Admin: change either fixed account's password. Takes effect immediately
// (auth.setPasswordHash) and is persisted to server/.env so it survives a
// restart — same STUDIO_PASSWORD_HASH/ADMIN_PASSWORD_HASH keys hash-password.js
// already documents setting by hand.
app.post('/api/admin/password', requireAuth('admin'), (req, res) => {
  const { role, newPassword } = req.body || {};
  if (role !== 'studio' && role !== 'admin') {
    res.status(400).json({ error: 'role must be "studio" or "admin"' });
    return;
  }
  const complexityError = passwordComplexityError(newPassword);
  if (complexityError) {
    res.status(400).json({ error: complexityError });
    return;
  }

  const hash = hashPassword(newPassword);
  auth.setPasswordHash(role, hash);
  setEnvValue(ENV_FILE, role === 'studio' ? 'STUDIO_PASSWORD_HASH' : 'ADMIN_PASSWORD_HASH', hash);
  res.json({ ok: true });
});

// Admin: enable/disable new links (global kill switch) and force-terminate
// one specific live link.
app.post('/api/admin/enabled', requireAuth('admin'), (req, res) => {
  linkEnabled = Boolean(req.body?.enabled);
  res.json({ enabled: linkEnabled });
});

app.post('/api/admin/links/:id/terminate', requireAuth('admin'), (req, res) => {
  endLinkSession(req.params.id, 'admin-terminated');
  res.json({ active: liveLinks.has(req.params.id) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const role = auth.login(username, password);
  if (!role) {
    res.status(401).json({ error: 'invalid credentials' });
    return;
  }
  const token = auth.createSession(role);
  res.setHeader(
    'Set-Cookie',
    `${AUTH_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${AUTH_SESSION_HOURS * 3600}`,
  );
  res.json({ role });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[AUTH_COOKIE];
  if (token) auth.destroySession(token);
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/whoami', (req, res) => {
  const session = getAuthSession(req);
  res.json({ role: session ? session.role : null });
});

// Localhost only — Caddy is the sole intended entry point (TLS, and now
// admin auth). Binding to all interfaces would let anyone on the LAN hit
// the app directly over plain HTTP, bypassing both.
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`audiolink server listening on http://localhost:${PORT}`);
});

// Signaling relay, scoped per Link (multi-link Stage 3) instead of one
// global broadcast domain — with more than one Link live at once, a naive
// broadcast would leak Link A's SDP/ICE to Link B's peers.
//
// peers maps ws -> { role, linkId } (both null until 'hello' arrives).
// liveLinks maps linkId -> { studioWs, clientWs, startedAt, timeoutHandle }
// and only has an entry while some Studio browser has actually claimed
// that Link — claiming and releasing both happen via the WebSocket
// lifecycle (see 'hello' and the close handler below), not separate
// activate/deactivate messages, since a Studio's start()/stop() already
// does a full reconnect per attempt (same as it always has).
//
// A Link is released (removed from liveLinks) whenever its session ends
// for any reason — the Studio side's existing kiosk auto-rearm (unchanged
// from single-link days) immediately reclaims it with a fresh connection,
// same as "the Link is then available to any browser on the Studio page
// to start again" describes; it's just usually the same browser winning
// that race back to it.
const wss = new WebSocketServer({ server, path: '/signal' });
const peers = new Map();
const liveLinks = new Map();
let linkEnabled = true;

function relay(sender, data) {
  const senderInfo = peers.get(sender);
  const live = senderInfo && liveLinks.get(senderInfo.linkId);
  if (!live) return;
  const target = sender === live.studioWs ? live.clientWs : sender === live.clientWs ? live.studioWs : null;
  if (target && target.readyState === WebSocket.OPEN) {
    target.send(data.toString());
  }
}

function notifyPeerJoined(linkId) {
  for (const [peer, info] of peers) {
    if (info.linkId === linkId && info.role === 'offerer' && peer.readyState === WebSocket.OPEN) {
      peer.send(JSON.stringify({ type: 'peer-joined' }));
    }
  }
}

function endLinkSession(linkId, reason) {
  const live = liveLinks.get(linkId);
  if (!live) return;
  clearTimeout(live.timeoutHandle);
  // Only log a stop if there was actually a call live (a Link that was
  // merely armed, then released without ever connecting, isn't a call
  // "starting and stopping" per the requirements doc — it's just arming).
  if (live.clientWs) {
    logEvent('link-stopped', { linkId, name: linkRegistry.get(linkId)?.name, reason });
  }
  const msg = JSON.stringify({ type: 'link-ended', reason });
  for (const ws of [live.studioWs, live.clientWs]) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
  liveLinks.delete(linkId);
}

wss.on('connection', (ws) => {
  peers.set(ws, { role: null, linkId: null });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (msg.type === 'hello') {
      if (!linkRegistry.get(msg.linkId)) {
        ws.send(JSON.stringify({ type: 'link-not-found' }));
        return;
      }

      if (msg.role === 'answerer') {
        if (!linkEnabled) {
          ws.send(JSON.stringify({ type: 'unavailable' }));
          return;
        }
        const existing = liveLinks.get(msg.linkId);
        if (existing?.studioWs && existing.studioWs !== ws && existing.studioWs.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'link-claimed' }));
          return;
        }
        peers.set(ws, { role: 'answerer', linkId: msg.linkId });
        liveLinks.set(msg.linkId, { studioWs: ws, clientWs: null, startedAt: null, timeoutHandle: null });
        ws.send(JSON.stringify({ type: 'activated' }));
        notifyPeerJoined(msg.linkId);
        return;
      }

      // offerer
      peers.set(ws, { role: 'offerer', linkId: msg.linkId });
      const armed = liveLinks.get(msg.linkId)?.studioWs?.readyState === WebSocket.OPEN;
      ws.send(JSON.stringify({ type: 'peer-count', count: armed ? 1 : 0 }));
      return;
    }

    if (msg.type === 'offer') {
      const info = peers.get(ws);
      const live = liveLinks.get(info.linkId);

      if (!linkEnabled) {
        ws.send(JSON.stringify({ type: 'unavailable' }));
        return;
      }
      if (!live || !live.studioWs || live.studioWs.readyState !== WebSocket.OPEN) {
        // Studio armed, then disappeared, in the gap between this client's
        // waitForPeer() resolving and its offer actually arriving — rare
        // enough not to build real buffering for; just drop it.
        return;
      }
      if (live.clientWs && live.clientWs !== ws && live.clientWs.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'busy' }));
        return;
      }

      live.clientWs = ws;
      live.startedAt = Date.now();
      live.timeoutHandle = setTimeout(() => endLinkSession(info.linkId, 'timeout'), SESSION_TIMEOUT_MS);
      logEvent('link-started', { linkId: info.linkId, name: linkRegistry.get(info.linkId)?.name });
    }

    relay(ws, data);
  });

  ws.on('close', () => {
    const info = peers.get(ws);
    peers.delete(ws);
    if (!info?.linkId) return;
    const live = liveLinks.get(info.linkId);
    if (live && (ws === live.studioWs || ws === live.clientWs)) {
      endLinkSession(info.linkId, 'peer-ended');
    }
  });
});

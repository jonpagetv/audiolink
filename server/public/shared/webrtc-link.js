// Shared WebRTC code path for both ends of the link (client and studio
// both call this the same way — see CLAUDE.md's "one codebase" decision).
// role: 'offerer' (client — initiates, per requirements) or 'answerer' (studio).
import { supportsOutputSelection } from './device-picker.js';

// Exported so client.js/studio.js can set the same status-badge look (see
// style.css) for the handful of status texts they set directly outside
// createLink (preflight busy/unavailable checks, device errors) — keeps
// every status update, inside or outside this module, using one consistent
// text+class pairing instead of some call sites forgetting the class.
export function setStatusBadge(el, text, kind = 'idle') {
  if (!el) return;
  el.textContent = text;
  el.className = `status-badge status-${kind}`;
}

export function createLink({ role, statusEl, remoteAudioEl, rttEl, onEnded }) {
  let ws = null;
  let pc = null;
  let localStream = null;
  let peerPresent = false;
  let onPeerPresent = null;
  let outputDeviceId = null;
  let linkId = null;
  let statsInterval = null;
  let onActivated = null; // answerer only: resolve/reject of the hello->activation round trip
  let qualityProblemActive = false; // debounce: log once per problem episode, not once per second

  // Rough, unvalidated defaults — nothing in the requirements doc specifies
  // exact numbers, just that quality problems should be logged. Tune once
  // there's real-world data to tune against (see CLAUDE.md's still-open
  // RTT-vs-perceived-delay investigation).
  const QUALITY_THRESHOLDS = { rttMs: 300, jitterMs: 100, packetLossRatio: 0.05 };

  // The server never sees actual media (it's relayed via TURN, never
  // proxied through the app), so quality problems can only be detected
  // here in the browser and reported back for the audit log.
  function reportQualityProblem(detail) {
    if (!linkId) return;
    fetch(`/api/links/${linkId}/quality-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ detail }),
    }).catch(() => {});
  }

  // Transport-level round-trip time from the active TURN relay path — the
  // closest thing to an objective <100ms check we can read straight from
  // the browser. It's not the same number as one-way audio latency (that
  // also includes capture/encode/jitter-buffer/decode delay), but it's a
  // consistent, repeatable stand-in for "does this feel fast" guesswork.
  function startStatsPolling() {
    stopStatsPolling();
    statsInterval = setInterval(async () => {
      if (!pc) return;
      const stats = await pc.getStats();
      let rtt = null;
      let jitter = null;
      let packetsLost = null;
      let packetsReceived = null;
      stats.forEach((report) => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
          if (typeof report.currentRoundTripTime === 'number') {
            rtt = report.currentRoundTripTime;
          }
        } else if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          if (typeof report.jitter === 'number') jitter = report.jitter;
          if (typeof report.packetsLost === 'number') packetsLost = report.packetsLost;
          if (typeof report.packetsReceived === 'number') packetsReceived = report.packetsReceived;
        }
      });
      if (rttEl) {
        rttEl.textContent = rtt != null ? `${Math.round(rtt * 1000)} ms` : '—';
      }

      const problems = [];
      if (rtt != null && rtt * 1000 > QUALITY_THRESHOLDS.rttMs) {
        problems.push(`high round-trip time (${Math.round(rtt * 1000)}ms)`);
      }
      if (jitter != null && jitter * 1000 > QUALITY_THRESHOLDS.jitterMs) {
        problems.push(`high jitter (${Math.round(jitter * 1000)}ms)`);
      }
      if (packetsLost != null && packetsReceived != null && packetsLost + packetsReceived > 0) {
        const lossRatio = packetsLost / (packetsLost + packetsReceived);
        if (lossRatio > QUALITY_THRESHOLDS.packetLossRatio) {
          problems.push(`packet loss (${Math.round(lossRatio * 100)}%)`);
        }
      }
      // Debounced: only report when *newly* crossing into a problem state,
      // not every second the problem persists, and reset once it clears so
      // a later, separate episode can be reported again.
      if (problems.length > 0 && !qualityProblemActive) {
        qualityProblemActive = true;
        reportQualityProblem(problems.join(', '));
      } else if (problems.length === 0) {
        qualityProblemActive = false;
      }
    }, 1000);
  }

  function stopStatsPolling() {
    if (statsInterval) {
      clearInterval(statsInterval);
      statsInterval = null;
    }
    if (rttEl) rttEl.textContent = '—';
  }

  // kind drives the status-badge color (see style.css): 'pending' (blue, in
  // progress), 'live' (green, pulsing), 'warning' (amber), 'error' (red),
  // or 'idle' (gray) — set explicitly at each call site rather than
  // inferred from the text, since the text is free-form/user-facing.
  function setStatus(text, kind = 'pending') {
    setStatusBadge(statusEl, text, kind);
  }

  function send(msg) {
    ws.send(JSON.stringify(msg));
  }

  // The server doesn't buffer messages for a peer that hasn't connected
  // yet, so the offerer has to know a peer is actually there before it
  // sends — otherwise the offer can be dropped and both sides hang
  // waiting forever.
  function markPeerPresent() {
    peerPresent = true;
    if (onPeerPresent) {
      onPeerPresent();
      onPeerPresent = null;
    }
  }

  function waitForPeer() {
    if (peerPresent) return Promise.resolve();
    return new Promise((resolve) => {
      onPeerPresent = resolve;
    });
  }

  // Answerer only: a Studio's hello doubles as its attempt to claim this
  // Link (see server/index.js) — it can be rejected (already claimed by
  // another Studio browser, disabled, or the Link no longer exists), so
  // start() waits for an explicit accept/reject rather than assuming success.
  function waitForActivation() {
    return new Promise((resolve, reject) => {
      onActivated = { resolve, reject };
    });
  }

  function settleActivation(result) {
    if (!onActivated) return;
    if (result.ok) onActivated.resolve();
    else onActivated.reject(new Error(result.message));
    onActivated = null;
  }

  async function fetchIceConfig() {
    const res = await fetch('/api/ice-config');
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `ICE config request failed: ${res.status}`);
    }
    return res.json();
  }

  function connectSignaling() {
    return new Promise((resolve, reject) => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${protocol}//${location.host}/signal`);
      ws.addEventListener('open', () => {
        send({ type: 'hello', role, linkId });
        resolve();
      }, { once: true });
      ws.addEventListener('error', () => reject(new Error('signaling connection failed')), { once: true });
      ws.addEventListener('message', onSignalMessage);
      // Only for a close we didn't initiate ourselves — stop() already
      // nulls out `ws` before this fires when *we* closed it, so this
      // guard keeps an expected stop from being overwritten by a generic
      // "disconnected" status racing in right after the specific reason.
      ws.addEventListener('close', () => {
        if (ws) stop('peer-ended');
      });
    });
  }

  async function onSignalMessage(event) {
    const msg = JSON.parse(event.data);

    if (msg.type === 'peer-count') {
      if (msg.count > 0) markPeerPresent();
    } else if (msg.type === 'peer-joined') {
      markPeerPresent();
    } else if (msg.type === 'activated') {
      settleActivation({ ok: true });
    } else if (msg.type === 'link-not-found') {
      settleActivation({ ok: false, message: 'link not found' });
      stop('link-not-found');
    } else if (msg.type === 'link-claimed') {
      settleActivation({ ok: false, message: 'this Link is already active on another browser' });
      stop('link-claimed');
    } else if (msg.type === 'busy') {
      stop('busy');
    } else if (msg.type === 'unavailable') {
      settleActivation({ ok: false, message: 'link is currently unavailable' });
      stop('unavailable');
    } else if (msg.type === 'link-ended') {
      stop(msg.reason || 'peer-ended');
    } else if (msg.type === 'offer' && role === 'answerer') {
      await pc.setRemoteDescription(msg.payload);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'answer', payload: pc.localDescription });
    } else if (msg.type === 'answer' && role === 'offerer') {
      await pc.setRemoteDescription(msg.payload);
    } else if (msg.type === 'ice-candidate' && msg.payload) {
      try {
        await pc.addIceCandidate(msg.payload);
      } catch (err) {
        console.error('addIceCandidate failed', err);
      }
    }
  }

  async function createPeerConnection() {
    const iceConfig = await fetchIceConfig();
    pc = new RTCPeerConnection({
      iceServers: iceConfig.iceServers,
      iceTransportPolicy: iceConfig.iceTransportPolicy,
    });

    pc.addEventListener('icecandidate', (event) => {
      send({ type: 'ice-candidate', payload: event.candidate });
    });

    pc.addEventListener('connectionstatechange', () => {
      const kind =
        pc.connectionState === 'connected'
          ? 'live'
          : pc.connectionState === 'failed' || pc.connectionState === 'disconnected'
            ? 'error'
            : pc.connectionState === 'closed'
              ? 'idle'
              : 'pending';
      setStatus(pc.connectionState, kind);
      if (pc.connectionState === 'connected') {
        startStatsPolling();
        qualityProblemActive = false; // fresh call, let a later problem be reported anew
      } else {
        stopStatsPolling();
      }
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        reportQualityProblem(`connection ${pc.connectionState}`);
      }
    });

    pc.addEventListener('track', (event) => {
      if (!remoteAudioEl) return;
      remoteAudioEl.srcObject = event.streams[0];
      if (outputDeviceId && supportsOutputSelection()) {
        remoteAudioEl.setSinkId(outputDeviceId).catch((err) => {
          console.error('setSinkId failed', err);
        });
      }
    });

    for (const track of localStream.getTracks()) {
      pc.addTrack(track, localStream);
    }
  }

  async function start({ inputDeviceId, outputDeviceId: outputId, linkId: id } = {}) {
    outputDeviceId = outputId || null;
    linkId = id || null;

    setStatus('requesting microphone...', 'pending');
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: inputDeviceId ? { deviceId: { exact: inputDeviceId } } : true,
    });

    // Peer connection must exist before the signaling socket opens — the
    // socket's message handler assumes `pc` is set, and a message (e.g. an
    // offer) can arrive as soon as the connection is live.
    setStatus('setting up connection...', 'pending');
    await createPeerConnection();

    setStatus('connecting to signaling server...', 'pending');
    await connectSignaling();

    if (role === 'offerer') {
      // Matches docs/requirements.md's suggested wording. Technically this
      // still auto-connects the moment a Studio activates the Link — no
      // actual retry needed — but the wording is what a non-technical
      // caller sees, and the doc calls for this specific phrasing.
      setStatus('waiting for studio, please try again shortly...', 'pending');
      await waitForPeer();

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send({ type: 'offer', payload: pc.localDescription });
      setStatus('waiting for answer...', 'pending');
    } else {
      setStatus('activating...', 'pending');
      await waitForActivation();
      setStatus('waiting for client...', 'pending');
    }
  }

  const STATUS_BY_REASON = {
    manual: 'idle',
    timeout: 'session timed out',
    'peer-ended': 'the other side disconnected',
    busy: 'busy — another session is already active',
    unavailable: 'link is currently unavailable',
    'admin-terminated': 'ended by admin',
    'link-not-found': 'link not found',
    'link-claimed': 'this Link is already active on another browser',
  };

  // Badge color per stop reason: a plain session end is just idle/gray;
  // busy/unavailable/claimed are "try again" amber warnings, not failures;
  // a bad link id is a genuine red error.
  const KIND_BY_REASON = {
    manual: 'idle',
    timeout: 'idle',
    'peer-ended': 'idle',
    busy: 'warning',
    unavailable: 'warning',
    'admin-terminated': 'idle',
    'link-not-found': 'error',
    'link-claimed': 'warning',
  };

  function stop(reason = 'manual') {
    stopStatsPolling();
    if (pc) {
      pc.close();
      pc = null;
    }
    if (ws) {
      ws.close();
      ws = null;
    }
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      localStream = null;
    }
    setStatus(STATUS_BY_REASON[reason] || 'idle', KIND_BY_REASON[reason] || 'idle');
    if (onEnded) onEnded(reason);
  }

  return { start, stop };
}

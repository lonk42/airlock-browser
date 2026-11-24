// Preload for site pages and their iframes, only with media.dtmf set: sends
// DTMF tones into the page's WebRTC calls for the bar's keypad. Nothing is
// exposed to the page.
//
// The hook runs in the page's world before its scripts, and records every
// RTCPeerConnection the page uses. It hands back a send function to this
// preload, so the page has no global to find.
// - voice: the tones are mixed into the outgoing audio, in band. Each audio
//   sender's track is swapped for a mix of it and the tones while dialling,
//   and put back once dialling has stopped for a moment.
// - rfc4733: RTCDTMFSender.insertDTMF, telephone-event packets, for a server
//   that negotiates them.
const { contextBridge, ipcRenderer } = require('electron');

function hook() {
  const live = new Set();
  const proto = window.RTCPeerConnection && window.RTCPeerConnection.prototype;
  if (!proto) return null;
  for (const name of ['addTrack', 'addTransceiver', 'setLocalDescription', 'setRemoteDescription']) {
    const orig = proto[name];
    if (typeof orig !== 'function') continue;
    const wrapped = { [name](...args) { live.add(this); return orig.apply(this, args); } }[name];
    Object.defineProperty(proto, name, { ...Object.getOwnPropertyDescriptor(proto, name), value: wrapped });
  }

  // Audio senders of live calls, whether or not they have a track now: a page
  // may mute with replaceTrack(null).
  function senders() {
    const out = [];
    for (const pc of live) {
      if (pc.connectionState === 'closed' || pc.signalingState === 'closed') { live.delete(pc); continue; }
      for (const t of pc.getTransceivers()) {
        if (t.stopped || !t.receiver.track || t.receiver.track.kind !== 'audio') continue;
        if (!/send/.test(t.currentDirection || '')) continue;
        out.push(t.sender);
      }
    }
    return out;
  }

  // ITU-T Q.23 pairs; durations as most IVRs and conference bridges expect.
  const LOW = { 1: 697, 2: 697, 3: 697, A: 697, 4: 770, 5: 770, 6: 770, B: 770, 7: 852, 8: 852, 9: 852, C: 852, '*': 941, 0: 941, '#': 941, D: 941 };
  const HIGH = { 1: 1209, 4: 1209, 7: 1209, '*': 1209, 2: 1336, 5: 1336, 8: 1336, 0: 1336, 3: 1477, 6: 1477, 9: 1477, '#': 1477, A: 1633, B: 1633, C: 1633, D: 1633 };
  const TONE_S = 0.16;
  const GAP_S = 0.1;
  const RESTORE_MS = 2000;
  const LEVEL = 0.25; // Each of the two tones; about -6 dBFS together.
  const LOCAL_LEVEL = 0.3; // The user hears their own tones quieter.

  let ctx = null;
  let bus = null;
  let next = 0; // When the next tone may start, in ctx time.
  let restoreTimer = null;
  const mixed = new Map(); // sender -> { orig, mix, source, dest }

  function audio() {
    if (ctx) return;
    ctx = new AudioContext({ latencyHint: 'interactive' });
    bus = ctx.createGain();
    const local = ctx.createGain();
    local.gain.value = LOCAL_LEVEL;
    bus.connect(local).connect(ctx.destination);
  }

  async function mixInto(sender) {
    const had = mixed.get(sender);
    if (had && sender.track === had.mix) return true;
    if (had) mixed.delete(sender); // The page replaced the track since.
    const orig = sender.track;
    const dest = ctx.createMediaStreamDestination();
    const source = orig && orig.readyState === 'live' ? ctx.createMediaStreamSource(new MediaStream([orig])) : null;
    if (source) source.connect(dest);
    bus.connect(dest);
    const mix = dest.stream.getAudioTracks()[0];
    try { await sender.replaceTrack(mix); } catch {
      if (source) source.disconnect();
      bus.disconnect(dest);
      mix.stop();
      return false;
    }
    mixed.set(sender, { orig, mix, source, dest });
    return true;
  }

  async function restore() {
    restoreTimer = null;
    for (const [sender, m] of mixed) {
      mixed.delete(sender);
      // Only if the page has not replaced the track itself meanwhile.
      if (sender.track === m.mix) {
        try { await sender.replaceTrack(m.orig && m.orig.readyState === 'live' ? m.orig : null); } catch { /* the call ended */ }
      }
      if (m.source) m.source.disconnect();
      bus.disconnect(m.dest);
      m.mix.stop();
    }
  }

  function play(digits) {
    const start = Math.max(ctx.currentTime + 0.05, next);
    let t = start;
    for (const d of digits) {
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(LEVEL, t + 0.005);
      env.gain.setValueAtTime(LEVEL, t + TONE_S - 0.005);
      env.gain.linearRampToValueAtTime(0, t + TONE_S);
      env.connect(bus);
      for (const f of [LOW[d], HIGH[d]]) {
        const osc = ctx.createOscillator();
        osc.frequency.value = f;
        osc.connect(env);
        osc.start(t);
        osc.stop(t + TONE_S);
      }
      setTimeout(() => env.disconnect(), (t + TONE_S - ctx.currentTime) * 1000 + 100);
      t += TONE_S + GAP_S;
    }
    next = t;
    return (t - ctx.currentTime) * 1000;
  }

  // Sends the digits on every live call; resolves to the number of calls reached.
  return async function send(digits, mode) {
    digits = String(digits).toUpperCase().replace(/[^0-9*#A-D]/g, '');
    if (!digits) return 0;
    const all = senders();
    if (mode === 'rfc4733') {
      let n = 0;
      for (const s of all) {
        if (!s.dtmf || !s.dtmf.canInsertDTMF) continue;
        s.dtmf.insertDTMF(s.dtmf.toneBuffer + digits, TONE_S * 1000, GAP_S * 1000);
        n += 1;
      }
      return n;
    }
    if (!all.length) return 0;
    audio();
    if (ctx.state !== 'running') await ctx.resume();
    clearTimeout(restoreTimer);
    let n = 0;
    for (const s of all) if (await mixInto(s)) n += 1;
    const ms = play(digits);
    restoreTimer = setTimeout(restore, ms + RESTORE_MS);
    return n;
  };
}

// Every frame runs this, iframes included; only a frame with RTCPeerConnection
// tells the main process it can take keys.
let send = null;
try { send = contextBridge.executeInMainWorld({ func: hook }); } catch { /* no page world, such as a status page */ }
if (send) ipcRenderer.send('page:dtmf-hello');

ipcRenderer.on('page:dtmf', async (event, id, digits, mode) => {
  let reached = 0;
  try { reached = send ? await send(digits, mode) : 0; } catch { reached = 0; }
  ipcRenderer.send('page:dtmf-sent', id, reached);
});

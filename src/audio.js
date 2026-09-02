// audio.js — Rock Climber: The Ritual
// Every sound effect is synthesised live in WebAudio (no samples): a wind bed that follows height and
// night, grip / release / rune / fall / catch cues, a heartbeat under low stamina, plus one looped music
// track routed through the same graph so iOS respects our ~0.35 gain (HTMLAudioElement.volume is
// read-only there). The single export is createAudio(); see CONTRACTS.md, section "hud-audio".
//
// Lifecycle: the AudioContext is created inside unlock(), which must run in a user gesture on iOS.
// main.js calls unlock() on the first gesture; this module also arms its own one-shot listeners as a
// fallback, and unlock() is idempotent.
//
// Integration notes for main.js: setMusic(url) may be called before or after unlock(). If the track
// stays silent on a device (e.g. iPhone Safari against a LAN server without HTTP Range support), call
// setMusic(url, { decode: true }) to play the decoded loop instead; the element path also falls back
// to it on a media error or after 8 s without decodable data. audio.debug() exposes wind level,
// music state, heartbeat count and the master RMS for evidence capture.

const MUTE_KEY = 'ritual.muted';
const MUSIC_GAIN = 0.35;
const MAX_CUES_PER_FRAME = 6;

function readMuted() {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { return false; }
}
function writeMuted(b) {
  try { localStorage.setItem(MUTE_KEY, b ? '1' : '0'); } catch (e) { /* ignore */ }
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function createAudio() {
  let ctx = null;
  let master = null;
  let comp = null;
  let noiseBuf = null;
  let wind = null;

  let music = null;          // HTMLAudioElement
  let musicUrl = null;
  let musicNode = null;      // MediaElementAudioSourceNode
  let musicGain = null;
  let musicWanted = false;   // play() succeeded at least once → element is unlocked on iOS
  let retryArmed = false;
  let musicFallback = null;  // { src: AudioBufferSourceNode|null } once the element gave up and the track is decoded instead
  let musicCheckTimer = 0;
  let pendingDecode = false; // setMusic(url, { decode: true }) before unlock
  let meter = null;          // AnalyserNode on the master bus, for tests and evidence only
  let meterBuf = null;

  const heart = { t: 0.4, beats: 0 };
  let gust = 0, gustV = 0, autoT = 0;
  let lastPhase = null;
  let cuesThisFrame = 0;

  const audio = {
    muted: readMuted(),
    unlocked: false,
    get ctx() { return ctx; },
    unlock,
    handle,
    setMusic,
    setMuted,
    cue,
    dispose,
    // read-only snapshot for tests and evidence capture (window.__ritual.audio.debug())
    debug() {
      return {
        ctx: ctx ? ctx.state : 'none',
        unlocked: audio.unlocked,
        muted: audio.muted,
        wind: wind ? { level: +wind.level.toFixed(3), gain: +wind.gBp.gain.value.toFixed(3), rumble: +wind.gLp.gain.value.toFixed(3), hz: Math.round(wind.bp.frequency.value) } : null,
        music: music ? { url: musicUrl, playing: (!music.paused && !music.ended) || !!(musicFallback && musicFallback.src), time: +music.currentTime.toFixed(1), duration: isFinite(music.duration) ? +music.duration.toFixed(1) : null, gain: musicGain ? +musicGain.gain.value.toFixed(3) : null, readyState: music.readyState, fallback: !!musicFallback } : null,
        heartIn: +heart.t.toFixed(2),
        heartbeats: heart.beats,
        rms: rms(),
      };
    },
  };

  // ---- graph ------------------------------------------------------------------------------------
  function buildGraph() {
    master = ctx.createGain();
    master.gain.value = audio.muted ? 0 : 1;
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 18;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    master.connect(comp).connect(ctx.destination);
    meter = ctx.createAnalyser();
    meter.fftSize = 2048;
    meter.smoothingTimeConstant = 0;
    comp.connect(meter);
    meterBuf = new Float32Array(meter.fftSize);

    // 2 s of white noise, looped by every noise voice with a random start offset
    const n = Math.floor(ctx.sampleRate * 2);
    noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;

    buildWind();
  }

  function buildWind() {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    // whistle: band-passed noise whose centre drifts with a slow LFO
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 420;
    bp.Q.value = 0.9;
    const gBp = ctx.createGain();
    gBp.gain.value = 0;
    // body: low rumble under the whistle
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 150;
    lp.Q.value = 0.4;
    const gLp = ctx.createGain();
    gLp.gain.value = 0;
    src.connect(bp).connect(gBp).connect(master);
    src.connect(lp).connect(gLp).connect(master);

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 170;
    lfo.connect(lfoG).connect(bp.frequency);
    lfo.start();

    const lfo2 = ctx.createOscillator();
    lfo2.type = 'sine';
    lfo2.frequency.value = 0.21;
    const lfo2G = ctx.createGain();
    lfo2G.gain.value = 0;
    lfo2.connect(lfo2G).connect(gBp.gain);
    lfo2.start();

    src.start();
    wind = { src, bp, lp, gBp, gLp, lfo, lfo2, lfoG, lfo2G, level: 0 };
  }

  // RMS of the last ~46 ms of master output (post-compressor), 0 when nothing is playing.
  function rms() {
    if (!meter) return 0;
    meter.getFloatTimeDomainData(meterBuf);
    let sum = 0;
    for (let i = 0; i < meterBuf.length; i++) sum += meterBuf[i] * meterBuf[i];
    return +Math.sqrt(sum / meterBuf.length).toFixed(4);
  }

  // ---- voices ------------------------------------------------------------------------------------
  const now = () => ctx.currentTime;

  function env(param, t, peak, a, d) {
    const p = Math.max(peak, 0.0003);
    param.cancelScheduledValues(t);
    param.setValueAtTime(0.0002, t);
    param.exponentialRampToValueAtTime(p, t + Math.max(a, 0.001));
    param.exponentialRampToValueAtTime(0.0002, t + a + Math.max(d, 0.01));
  }
  function tone(type, f0, f1, t, dur, peak, a = 0.005, dest = master) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    env(g.gain, t, peak, a, dur - a);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.08);
    return o;
  }
  function noise(t, dur, peak, o = {}) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.Q.value = o.q != null ? o.q : 0.8;
    f.frequency.setValueAtTime(o.f0 || 800, t);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t + dur);
    const g = ctx.createGain();
    const a = o.a != null ? o.a : 0.005;
    env(g.gain, t, peak, a, dur - a);
    s.connect(f).connect(g).connect(o.dest || master);
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur + 0.08);
  }
  function pan(side) {
    if (!ctx.createStereoPanner) return master;
    const p = ctx.createStereoPanner();
    p.pan.value = side === 'L' ? -0.45 : side === 'R' ? 0.45 : 0;
    p.connect(master);
    return p;
  }
  // bell made of a few inharmonic sine partials with staggered decays
  const PARTIALS = [[1, 1, 2.6], [2.0, 0.42, 2.0], [2.99, 0.26, 1.5], [4.36, 0.15, 1.1], [5.98, 0.07, 0.8]];
  function chime(f, vol, dest, t) {
    t = t || now();
    for (const [r, g, d] of PARTIALS) {
      const fr = f * r * (1 + (Math.random() - 0.5) * 0.003);
      tone('sine', fr, fr, t, d, vol * g, 0.008, dest);
    }
  }

  const CUES = {
    start() {
      const t = now();
      noise(t, 1.6, 0.16, { type: 'lowpass', f0: 110, f1: 900, a: 0.6, q: 0.5 });
      chime(330, 0.12, master, t + 0.2);
    },
    // the ground arriving: one heavy hit, then the air goes out of the scene
    impact() {
      const t = now();
      tone('sine', 90, 34, t, 0.9, 0.85, 0.002, null);
      noise(t, 0.55, 0.7, { type: 'lowpass', f0: 900, f1: 90, a: 0.001 });
      noise(t + 0.04, 1.6, 0.22, { type: 'lowpass', f0: 300, f1: 60, a: 0.02 });
    },
    // aiming: the shooter primes with a short mechanical tick
    aim(e) {
      const t = now(), d = pan(e && e.hand);
      tone('square', 1400, 900, t, 0.03, 0.05, 0.001, d);
    },
    // the shot: a real recorded air swish (CC0) with a click and a pressurised spray over it
    webshot(e) {
      const t = now(), d = pan(e && e.hand);
      playSample('thwip', t, 0.9, d);
      tone('square', 900, 320, t, 0.04, 0.11, 0.001, d);              // the shooter
      noise(t + 0.01, 0.22, 0.24, { type: 'highpass', f0: 2400, f1: 900, a: 0.002, dest: d });  // spray
    },
    webhit(e) {
      const t = now(), d = pan(e && e.hand);
      noise(t, 0.14, 0.30, { type: 'bandpass', f0: 700, f1: 240, q: 0.9, a: 0.001, dest: d });
      tone('sine', 150, 70, t, 0.20, 0.24, 0.003, d);
    },
    webcut(e) {
      const t = now(), d = pan(e && e.hand);
      noise(t, 0.18, 0.16, { type: 'highpass', f0: 1400, f1: 500, a: 0.004, dest: d });
    },
    webmiss(e) {
      const t = now(), d = pan(e && e.hand);
      noise(t, 0.10, 0.10, { type: 'bandpass', f0: 800, q: 1.2, a: 0.002, dest: d });
    },
    // a decoy giving way: dry crack, then grit falling away from under the fingers
    crumble(e) {
      const t = now(), d = pan(e.hand);
      tone('square', 190, 60, t, 0.05, 0.16, 0.001, d);
      noise(t, 0.10, 0.34, { type: 'bandpass', f0: 1500, f1: 380, q: 0.8, a: 0.001, dest: d });
      noise(t + 0.05, 0.55, 0.20, { type: 'highpass', f0: 900, f1: 240, a: 0.02, dest: d });
      tone('sine', 70, 44, t + 0.02, 0.28, 0.20, 0.004, d);
    },
    grab(e) {
      const t = now(), d = pan(e.hand);
      tone('sine', 82, 40, t, 0.17, 0.55, 0.003, d);            // thud
      noise(t, 0.09, 0.32, { type: 'lowpass', f0: 520, f1: 160, a: 0.002, dest: d });
      noise(t, 0.05, 0.10, { type: 'highpass', f0: 2600, a: 0.001, dest: d }); // chalk grit
    },
    release(e) {
      const t = now(), d = pan(e.hand);
      noise(t, 0.3, 0.17, { type: 'bandpass', f0: 480, f1: 1700, q: 1.1, a: 0.03, dest: d });
    },
    arm(e) {
      const t = now(), d = pan(e.hand);
      tone('triangle', 1500, 1500, t, 0.045, 0.06, 0.002, d);
    },
    miss(e) {
      const t = now(), d = pan(e.hand);
      tone('sine', 240, 140, t, 0.1, 0.13, 0.003, d);
      noise(t, 0.05, 0.07, { type: 'bandpass', f0: 900, dest: d });
    },
    slip(e) {
      const t = now(), d = pan(e.hand);
      noise(t, 0.24, 0.2, { type: 'highpass', f0: 1500, f1: 800, a: 0.01, dest: d });
      tone('sawtooth', 130, 80, t, 0.2, 0.035, 0.01, d);
    },
    rune(e) {
      const t = now(), d = pan(e.hand);
      chime(660, 0.34, d, t);
      chime(990, 0.16, d, t + 0.14);
      noise(t, 1.6, 0.05, { type: 'highpass', f0: 5000, a: 0.5, dest: d }); // shimmer
    },
    fall() {
      const t = now();
      noise(t, 0.95, 0.42, { type: 'bandpass', f0: 280, f1: 1600, q: 0.7, a: 0.16 });
      noise(t, 0.95, 0.24, { type: 'lowpass', f0: 220, f1: 90, a: 0.1, q: 0.5 });
      if (musicGain) musicGain.gain.setTargetAtTime(MUSIC_GAIN * 0.45, t, 0.12);
    },
    catch() {
      const t = now();
      tone('sine', 54, 30, t, 0.45, 0.78, 0.004);                 // harness thump
      noise(t, 0.15, 0.4, { type: 'lowpass', f0: 380, f1: 110, a: 0.002 });
      tone('sawtooth', 200, 105, t + 0.04, 0.28, 0.045, 0.02);    // rope creak
      if (musicGain) musicGain.gain.setTargetAtTime(audio.muted ? 0 : MUSIC_GAIN, t + 0.6, 1.2);
    },
    summit() {
      const t = now();
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => chime(f, 0.26 - i * 0.03, master, t + i * 0.17));
      tone('sine', 110, 110, t, 3.2, 0.22, 1.3);
      noise(t, 2.8, 0.05, { type: 'highpass', f0: 4200, a: 0.9 });
    },
  };

  function cue(type, e = {}) {
    if (!ctx || !audio.unlocked) return false;
    const fn = CUES[type];
    if (!fn || cuesThisFrame >= MAX_CUES_PER_FRAME) return false;
    cuesThisFrame++;
    try { fn(e); } catch (err) { console.warn('audio cue failed', type, err); }
    return true;
  }

  // ---- continuous layers ----------------------------------------------------------------------------
  function updateWind(state, dt) {
    if (!wind) return;
    const top = (state.route && state.route.top) || 40;
    const h01 = clamp((state.height || 0) / top, 0, 1);
    const night = clamp(state.night || 0, 0, 1);
    let level = 0.10 + 0.30 * h01 + 0.16 * night;
    if (state.phase === 'falling') {
      // A doomed plunge roars: the wind rises with speed instead of sitting at a fixed bump.
      const doomed = state._fall && state._fall.doomed;
      level += doomed ? 0.5 + 1.5 * Math.min(1, Math.abs(state.body.vy) / 22) : 0.5;
    }
    if (state.phase === 'fallen') level *= 0.25;        // after the ground, the air goes out

    // slow random-walk gusts on top of the LFO breathing
    gustV += (Math.random() - 0.5) * dt * 1.8;
    gustV *= Math.exp(-dt * 0.7);
    gust = clamp(gust + gustV * dt, -0.35, 0.65);

    autoT += dt;
    if (autoT >= 0.1) {
      autoT = 0;
      const t = now();
      const g = level * (1 + gust);
      wind.gBp.gain.setTargetAtTime(g, t, 0.3);
      wind.lfo2G.gain.setTargetAtTime(g * 0.4, t, 0.3);
      wind.gLp.gain.setTargetAtTime(level * 0.9 * (1 + gust * 0.6), t, 0.35);
      wind.bp.frequency.setTargetAtTime(380 + 480 * h01 + 120 * night, t, 0.6);
      wind.level = level;
    }
  }

  function updateHeart(state, dt) {
    const L = state.hands && state.hands.L, R = state.hands && state.hands.R;
    const minS = Math.min(L ? L.stamina : 1, R ? R.stamina : 1);
    const hanging = !!((L && L.gripping) || (R && R.gripping));
    if (state.phase === 'climbing' && hanging && minS < 0.25) {
      const k = (0.25 - clamp(minS, 0, 0.25)) / 0.25;
      heart.t -= dt;
      if (heart.t <= 0) {
        const t = now();
        const vol = 0.42 + 0.55 * k;
        tone('sine', 58, 40, t, 0.17, 0.5 * vol, 0.004);
        tone('sine', 50, 36, t + 0.18, 0.17, 0.34 * vol, 0.004);
        heart.t = 1.08 - 0.5 * k;
        heart.beats++;
      }
    } else {
      heart.t = Math.min(heart.t, 0.35);
    }
  }

  // ---- public: handle -----------------------------------------------------------------------------------
  function handle(events, state, dt = 1 / 60) {
    cuesThisFrame = 0;
    if (events && events.length && ctx && audio.unlocked) {
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e && e.type) cue(e.type, e);
      }
    }
    if (!state || !ctx || !audio.unlocked) return;
    dt = clamp(+dt || 1 / 60, 0, 0.1);
    updateWind(state, dt);
    updateHeart(state, dt);
    lastPhase = state.phase;
  }

  // ---- public: unlock ------------------------------------------------------------------------------------
  function unlock() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    if (!ctx) {
      try {
        ctx = new AC({ latencyHint: 'interactive' });
      } catch (e) {
        try { ctx = new AC(); } catch (e2) { return false; }
      }
      buildGraph();
    }
    if (ctx.state !== 'running') {
      const p = ctx.resume();
      if (p && p.catch) p.catch(() => {});
    }
    if (!audio.unlocked) {
      audio.unlocked = true;
      // ensure the wind never opens at full level: start from silence and let handle() ramp it
      wind.gBp.gain.value = 0;
      wind.gLp.gain.value = 0;
    }
    if (pendingDecode) { pendingDecode = false; fallbackMusic(); } else startMusic();
    return true;
  }

  // self-unlock fallback: idempotent with main.js calling unlock() from its own gesture handler
  const gestureEvents = ['pointerdown', 'touchend', 'keydown'];
  function onFirstGesture() {
    for (const ev of gestureEvents) window.removeEventListener(ev, onFirstGesture, true);
    unlock();
  }
  for (const ev of gestureEvents) window.addEventListener(ev, onFirstGesture, { capture: true, passive: true });

  function armRetry() {
    if (retryArmed) return;
    retryArmed = true;
    const retry = () => {
      retryArmed = false;
      for (const ev of gestureEvents) window.removeEventListener(ev, retry, true);
      if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
      startMusic();
    };
    for (const ev of gestureEvents) window.addEventListener(ev, retry, { capture: true, passive: true });
  }

  function onVisibility() {
    if (!ctx) return;
    if (document.hidden) {
      if (music && !music.paused) music.pause();
      if (ctx.state === 'running') ctx.suspend().catch(() => {});
    } else {
      if (ctx.state !== 'running') ctx.resume().catch(() => armRetry());
      if (musicWanted && !audio.muted) startMusic();
    }
  }
  document.addEventListener('visibilitychange', onVisibility);

  // ---- public: music --------------------------------------------------------------------------------------
  // setMusic(url, { decode: true }) skips the element and plays the decoded loop directly (LAN
  // servers without byte-range support, or when the element stays silent on a device).
  function setMusic(url, opts = {}) {
    musicUrl = url || null;
    if (musicFallback && musicFallback.src) { try { musicFallback.src.stop(); } catch (e) { /* ignore */ } }
    musicFallback = null;
    if (!musicUrl) {
      if (music) music.pause();
      return;
    }
    if (opts.decode) {
      if (audio.unlocked) fallbackMusic(); else pendingDecode = true;
      return;
    }
    pendingDecode = false;
    if (!music) {
      music = new Audio();
      music.loop = true;
      music.preload = 'auto';
      music.setAttribute('playsinline', '');
      // A server without byte-range support (or a codec quirk) makes iOS refuse the element; the
      // track is then fetched and decoded into a looping buffer instead of staying silent.
      music.addEventListener('error', () => { if (audio.unlocked) fallbackMusic(); });
    }
    if (music.getAttribute('src') !== musicUrl) {
      music.setAttribute('src', musicUrl);
      music.load();
    }
    if (audio.unlocked) startMusic();
  }
  function startMusic() {
    if (!music || !musicUrl || !ctx || !audio.unlocked || audio.muted) return;
    if (musicFallback) return;   // the decoded loop is already playing (or loading)
    if (!musicCheckTimer) {
      musicCheckTimer = setTimeout(() => {
        musicCheckTimer = 0;
        // eight seconds after the first attempt nothing is decodable: give up on the element
        if (music && !musicFallback && audio.unlocked && (music.readyState < 2 || music.error)) fallbackMusic();
      }, 8000);
    }
    if (!musicNode) {
      try {
        musicNode = ctx.createMediaElementSource(music);
        musicGain = ctx.createGain();
        musicGain.gain.value = 0;
        musicNode.connect(musicGain).connect(master);
      } catch (e) {
        // very old engines: fall back to the element's own volume
        musicNode = true;
        try { music.volume = MUSIC_GAIN; } catch (e2) { /* ignore */ }
      }
    }
    if (!music.paused && musicWanted) return;
    const p = music.play();
    if (p && p.then) {
      p.then(() => {
        musicWanted = true;
        if (musicGain) musicGain.gain.setTargetAtTime(MUSIC_GAIN, now(), 1.6);
      }, () => armRetry());
    } else {
      musicWanted = true;
      if (musicGain) musicGain.gain.setTargetAtTime(MUSIC_GAIN, now(), 1.6);
    }
  }

  // ---- one-shot samples -------------------------------------------------------------------
  // Everything else here is synthesised; the web shot layers one short recorded swish (CC0)
  // under its synth so the air sounds real. Loaded lazily on first use and cached.
  const samples = new Map();
  const SAMPLE_URLS = { thwip: 'assets/audio/thwip.mp3' };

  function playSample(name, when, gain = 1, dest = null) {
    if (!ctx || !audio.unlocked) return;
    const have = samples.get(name);
    if (have && have.buffer) {
      const src = ctx.createBufferSource();
      src.buffer = have.buffer;
      src.playbackRate.value = 0.94 + Math.random() * 0.12;    // never twice the same
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(g).connect(dest || master);
      try { src.start(when || ctx.currentTime); } catch (e) {}
      return;
    }
    if (have) return;                                          // already loading
    const url = SAMPLE_URLS[name];
    if (!url) return;
    const rec = { buffer: null };
    samples.set(name, rec);
    fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((ab) => ctx.decodeAudioData(ab))
      .then((buf) => { rec.buffer = buf; })
      .catch(() => { samples.delete(name); });                 // silent: the synth still fires
  }

  async function fallbackMusic() {
    if (musicFallback || !ctx || !musicUrl) return;
    musicFallback = { src: null };
    try {
      const res = await fetch(musicUrl);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const ab = await ctx.decodeAudioData(await res.arrayBuffer());
      if (!musicFallback) return;   // disposed meanwhile
      if (music && !music.paused) music.pause();
      if (!musicGain) {
        musicGain = ctx.createGain();
        musicGain.gain.value = 0;
        musicGain.connect(master);
      }
      const src = ctx.createBufferSource();
      src.buffer = ab;
      src.loop = true;
      src.connect(musicGain);
      src.start();
      musicFallback.src = src;
      musicWanted = true;
      musicGain.gain.setTargetAtTime(MUSIC_GAIN, now(), 1.6);
    } catch (err) {
      console.warn('music: element and decoded fallback both failed', err);
      musicFallback = null;
    }
  }

  // ---- public: mute -----------------------------------------------------------------------------------------
  function setMuted(b) {
    b = !!b;
    audio.muted = b;
    writeMuted(b);
    if (ctx && master) {
      master.gain.setTargetAtTime(b ? 0 : 1, now(), 0.04);
    }
    if (b) {
      if (music && !music.paused) setTimeout(() => { if (audio.muted && music) music.pause(); }, 120);
    } else if (audio.unlocked) {
      startMusic();
    }
  }

  function dispose() {
    for (const ev of gestureEvents) window.removeEventListener(ev, onFirstGesture, true);
    document.removeEventListener('visibilitychange', onVisibility);
    if (music) { music.pause(); music.removeAttribute('src'); music.load(); }
    if (musicFallback && musicFallback.src) { try { musicFallback.src.stop(); } catch (e) { /* ignore */ } }
    musicFallback = null;
    clearTimeout(musicCheckTimer);
    if (ctx) { try { ctx.close(); } catch (e) { /* ignore */ } }
    ctx = null;
    audio.unlocked = false;
  }

  return audio;
}

export default createAudio;

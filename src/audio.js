// audio.js — Rock Climber: The Ritual
// Every sound effect is synthesised live in WebAudio (no samples): a wind bed that follows height and
// night, grip / release / rune / fall / impact cues, a heartbeat under low stamina, plus two looped
// music tracks routed through the same graph so iOS respects our ~0.35 gain (HTMLAudioElement.volume
// is read-only there). The single export is createAudio(); see CONTRACTS.md, section "hud-audio".
//
// Lifecycle: the AudioContext is created inside unlock(), which must run in a user gesture on iOS.
// main.js calls unlock() on the first gesture; this module also arms its own one-shot listeners as a
// fallback, and unlock() is idempotent.
//
// Music (B61): setMusic(url) plays `url` as the climb's theme and, unless told otherwise, the night
// track that lives beside it (NIGHT_URL, assets/audio/theme2.mp3). The night track is a second
// element that runs SILENTLY under the theme from the same gesture, so iOS has already let it play
// by the time it is wanted. Past state.night 0.55 (about the second rune) the two cross-fade over
// 2 s; a NEW climb (a fresh state from restart()) seen under 0.45 while climbing fades the theme back
// in, and the same climb never hands back on its own; setMusic(null), the title, stops both. The
// fade only advances while the night track can be heard, so the theme never fades into silence, and
// a night track that fails outright is written off and the climb stays on the theme. Both sit under
// one bus that the wind ducks (B26) and the mute silences.
//
// Integration notes for main.js: setMusic(url, { night, decode }) may be called before or after
// unlock(). If a track stays silent on a device (e.g. iPhone Safari against a LAN server without
// HTTP Range support), call setMusic(url, { decode: true }) to play the decoded loops instead; the
// element path also falls back to it on a media error or after 8 s without decodable data.
// audio.debug() exposes wind level, music state, the fade, the last cue, heartbeat count and the
// master RMS for evidence capture.

const MUTE_KEY = 'ritual.muted';
const MUSIC_GAIN = 0.35;
const MAX_CUES_PER_FRAME = 6;

// The second track (B61). hud-audio owns assets/audio/*, so this module knows where its own night
// track lives and main.js keeps calling setMusic(url) with the theme alone.
const NIGHT_URL = new URL('../assets/audio/theme2.mp3', import.meta.url).href;
const NIGHT_AT = 0.55;        // state.night where the night track takes over: about the second rune
const NIGHT_BACK = 0.45;      // and under which a NEW climb brings the theme back (the same climb never does)
const XFADE_S = 2.0;          // the crossfade, both ways
// The night track is 5 LU quieter than the theme as shipped (-22.9 against -17.7 LUFS integrated,
// ffmpeg's ebur128 over the two files in assets/audio), so it is levelled in the graph rather than
// in the file. Its peak is -6.9 dBFS, so there is room for it.
const NIGHT_TRIM = 1.8;

function readMuted() {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { return false; }
}
function writeMuted(b) {
  try { localStorage.setItem(MUTE_KEY, b ? '1' : '0'); } catch (e) { /* ignore */ }
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// One music track: an HTMLAudioElement first, and a decoded looping buffer if the element gives up.
function makeTrack(name) {
  return {
    name,
    url: null,
    el: null,             // HTMLAudioElement
    node: null,           // MediaElementAudioSourceNode, or `true` on an engine that refused one
    fade: null,           // this track's side of the crossfade, into the shared bus
    wanted: false,        // play() succeeded at least once → the element is unlocked on iOS
    fallback: null,       // { src: AudioBufferSourceNode|null } once the track is decoded instead
    checkTimer: 0,
    pendingDecode: false, // setMusic(url, { decode: true }) before unlock
    deferred: false,      // the night track's decode waits until the fade wants it
    dead: false,          // gave up (a media error and a failed decode): the climb stays on the theme
  };
}

export function createAudio() {
  let ctx = null;
  let master = null;
  let comp = null;
  let noiseBuf = null;
  let wind = null;

  // The two tracks share one bus (musicGain: MUSIC_GAIN, ducked by the wind) and each cross-fades
  // through a gain of its own. `xfade` runs 0 (the theme) → 1 (the night track) at 1 / XFADE_S per second.
  const tracks = { day: makeTrack('day'), night: makeTrack('night') };
  let musicUrl = null;       // the theme, as setMusic was last told it; null is silence (the title)
  let musicGain = null;      // the shared bus
  let retryArmed = false;
  let xfade = 0, xfadeTo = 0, xfadeSent = -1;
  let lastState = null, armedBack = false;   // a fresh climber arms the hand-back; going up disarms it
  let meter = null;          // AnalyserNode on the master bus, for tests and evidence only
  let meterBuf = null;

  const heart = { t: 0.4, beats: 0 };
  let gust = 0, gustV = 0, autoT = 0;
  let duck = 0, duckSent = -1;      // 0 = music at full, 1 = fully under the wind
  let cuesThisFrame = 0;
  let curState = null;              // what handle() was last given, for cues that read the route
  const frameRunes = new Set();     // hold ids the 'rune' cue is answering this frame
  let lastCue = null;               // { type, at (audio s), wall (ms) } of the last cue that fired
  let holdMap = null, holdMapRoute = null;

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
      const day = tracks.day, night = tracks.night;
      return {
        ctx: ctx ? ctx.state : 'none',
        unlocked: audio.unlocked,
        muted: audio.muted,
        wind: wind ? { level: +wind.level.toFixed(3), gain: +wind.gBp.gain.value.toFixed(3), rumble: +wind.gLp.gain.value.toFixed(3), hz: Math.round(wind.bp.frequency.value) } : null,
        music: day.el ? { url: day.url, playing: trackPlaying(day), time: +day.el.currentTime.toFixed(1), duration: isFinite(day.el.duration) ? +day.el.duration.toFixed(1) : null, gain: musicGain ? +musicGain.gain.value.toFixed(3) : null, readyState: day.el.readyState, fallback: !!day.fallback } : null,
        night: night.el ? { url: night.url, playing: trackPlaying(night), time: +night.el.currentTime.toFixed(1), duration: isFinite(night.el.duration) ? +night.el.duration.toFixed(1) : null, readyState: night.el.readyState, fallback: !!night.fallback, dead: night.dead } : null,
        track: xfadeTo ? 'night' : 'day',
        xfade: +xfade.toFixed(3),
        nightReady: nightReady(),
        fades: { day: day.fade ? +day.fade.gain.value.toFixed(3) : null, night: night.fade ? +night.fade.gain.value.toFixed(3) : null },
        nightTrim: NIGHT_TRIM,
        duck: +duck.toFixed(3),
        heartIn: +heart.t.toFixed(2),
        heartbeats: heart.beats,
        lastCue,
        // ms between a cue's scheduled start and the speaker, as the engine reports it
        latency: ctx ? +(((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000).toFixed(1) : null,
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
  // `dest` may be omitted or null: both mean the master bus
  function tone(type, f0, f1, t, dur, peak, a = 0.005, dest = null) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    env(g.gain, t, peak, a, dur - a);
    o.connect(g).connect(dest || master);
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
  // Loose rock: `n` short bright ticks scattered over `span` seconds after `t`, each its own pitch
  // and (without a `dest`) its own side, front-loaded and dying away as the stones settle. The tail
  // of the ground hit and of a decoy going.
  function scatter(t, n, span, vol, dest) {
    for (let i = 0; i < n; i++) {
      const at = t + span * Math.pow(Math.random(), 0.7);
      const k = 1 - (at - t) / span;                        // the late ones are the quiet ones
      const d = dest || pan(Math.random() < 0.5 ? 'L' : 'R');
      const f = 1200 + Math.random() * 2400;
      noise(at, 0.02 + Math.random() * 0.02, vol * (0.35 + 0.65 * k), { type: 'bandpass', f0: f, q: 3.5, a: 0.001, dest: d });
      tone('sine', f * 0.5, f * 0.42, at, 0.03, vol * 0.25 * k, 0.001, d);
    }
  }
  // The hold behind an event, looked up in the route handle() was last given. One Map per route.
  function holdOf(id) {
    const route = curState && curState.route;
    if (!route || !route.holds || id == null) return null;
    if (holdMapRoute !== route) {
      holdMapRoute = route;
      holdMap = new Map();
      for (const h of route.holds) holdMap.set(h.id, h);
    }
    return holdMap.get(id) || null;
  }

  const CUES = {
    start() {
      const t = now();
      noise(t, 1.6, 0.16, { type: 'lowpass', f0: 110, f1: 900, a: 0.6, q: 0.5 });
      chime(330, 0.12, master, t + 0.2);
    },
    // the ground arriving (B53, B62): one heavy hit and the body's slap, then loose rock scattering
    // and settling while the air goes out of the scene. Scheduled at the frame's own audio time, so
    // the thud and the cut to black start together.
    impact() {
      const t = now();
      tone('sine', 90, 34, t, 0.9, 0.85, 0.002);                                      // the thud
      noise(t, 0.55, 0.7, { type: 'lowpass', f0: 900, f1: 90, a: 0.001 });            // the slap
      noise(t + 0.04, 1.6, 0.22, { type: 'lowpass', f0: 300, f1: 60, a: 0.02 });      // the air going out
      noise(t + 0.02, 0.45, 0.16, { type: 'highpass', f0: 2200, f1: 700, a: 0.01 });  // grit sliding
      scatter(t + 0.05, 8, 0.5, 0.22, null);                                          // stones settling
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
    // a decoy giving way (B62): a dry snap and crack, then grit falling away from under the fingers
    crumble(e) {
      const t = now(), d = pan(e.hand);
      noise(t, 0.012, 0.5, { type: 'highpass', f0: 3000, a: 0.001, dest: d });          // the snap
      tone('square', 190, 60, t, 0.05, 0.16, 0.001, d);                               // the crack
      noise(t, 0.10, 0.34, { type: 'bandpass', f0: 1500, f1: 380, q: 0.8, a: 0.001, dest: d });
      noise(t + 0.05, 0.55, 0.20, { type: 'highpass', f0: 900, f1: 240, a: 0.02, dest: d });  // grit
      tone('sine', 70, 44, t + 0.02, 0.28, 0.20, 0.004, d);                            // the weight going
      scatter(t + 0.04, 4, 0.3, 0.12, d);
    },
    grab(e) {
      const t = now(), d = pan(e.hand);
      tone('sine', 82, 40, t, 0.17, 0.55, 0.003, d);            // thud
      noise(t, 0.09, 0.32, { type: 'lowpass', f0: 520, f1: 160, a: 0.002, dest: d });
      noise(t, 0.05, 0.10, { type: 'highpass', f0: 2600, a: 0.001, dest: d }); // chalk grit
      // Taking a rune again — the checkpoint you rest on — answers with a soft chime (B62). The
      // first time, the 'rune' cue in the same frame is the answer and this stays quiet.
      const h = holdOf(e.holdId);
      if (h && h.kind === 'rune' && !frameRunes.has(h.id)) chime(660, 0.09, d, t + 0.03);
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
      // the music gets out of the way on its own now — updateDuck() follows the wind bed
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
    lastCue = { type, at: +ctx.currentTime.toFixed(3), wall: +performance.now().toFixed(1) };
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
      // The plunge roars: the wind rises with speed instead of sitting at a fixed bump.
      // B43: every fall runs the whole cliff, so the wind always roars up with the speed.
      level += 0.5 + 1.5 * Math.min(1, Math.abs(state.body.vy) / 22);
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

  // The music sat at a fixed gain and fought the wind: during a plunge the bed roars up to five
  // times its climbing level and the loop kept playing straight through it. The duck reads the
  // same `wind.level` the bed is built from, so it is the wind that pushes the music down, not a
  // list of events — a fall that ends on the ground still lets the bed come back up afterwards.
  // Fast to duck (0.16 s: the roar is already there), slow to lift (1.1 s), so the return is a
  // fade rather than a switch. It works on the bus, so both tracks duck as one.
  const DUCK_FROM = 0.42;          // wind level where the music starts giving way
  const DUCK_TO = 1.05;            // and where it is as far down as it goes
  const DUCK_DEPTH = 0.75;         // 1 = silent; a plunge leaves the music at a quarter of full

  function updateDuck(dt) {
    if (!wind) return;
    const level = wind.level;
    const x = clamp((level - DUCK_FROM) / (DUCK_TO - DUCK_FROM), 0, 1);
    const target = x * x * (3 - 2 * x);                   // smoothstep: no step when a gust crosses
    const tc = target > duck ? 0.16 : 1.1;                // duck fast, come back slowly
    duck += (target - duck) * (1 - Math.exp(-dt / tc));
    if (!musicGain || !anyWanted() || audio.muted) return;
    const g = MUSIC_GAIN * (1 - DUCK_DEPTH * duck);
    if (Math.abs(g - duckSent) < 0.002) return;           // only touch the graph when it moves
    duckSent = g;
    musicGain.gain.setTargetAtTime(g, now(), 0.08);
  }

  // The switch (B61). Past NIGHT_AT the night track takes over. A NEW climb — restart() hands the
  // module a fresh state — seen under NIGHT_BACK while climbing (or standing at the foot) hands the
  // theme back; the same climb never does on its own, so swinging down under the line and climbing
  // again keeps the night track, and a plunge, which runs `night` to 0, keeps it too. The title
  // (setMusic(null)) resets everything anyway. The fade towards the night track only advances while
  // that track can be heard (nightReady), so a slow one holds the theme until it is ready and the
  // theme never fades into silence; one that fails outright is written off (`dead`).
  function updateMusic(state, dt) {
    if (state !== lastState) { lastState = state; armedBack = true; }
    const n = tracks.night;
    if (n.url && !n.dead) {
      const night = clamp(state.night || 0, 0, 1);
      const ph = state.phase;
      if (xfadeTo === 0 && night >= NIGHT_AT && ph !== 'title') switchTo(1);
      else if (xfadeTo === 1 && armedBack && night < NIGHT_BACK && (ph === 'climbing' || ph === 'grounded')) switchTo(0);
    } else if (xfadeTo !== 0) switchTo(0);
    if (xfade !== xfadeTo && (xfadeTo === 0 || nightReady())) {
      const step = dt / XFADE_S;
      xfade = xfadeTo > xfade ? Math.min(xfadeTo, xfade + step) : Math.max(xfadeTo, xfade - step);
      if (Math.abs(xfade - xfadeTo) < 1e-6) xfade = xfadeTo;     // land exactly, not a rounding error away
    }
    applyXfade(false);
  }
  function switchTo(to) {
    xfadeTo = to;
    if (to !== 1) return;
    armedBack = false;                          // this climb has gone up: only a new one hands back
    const n = tracks.night;
    if (n.deferred) {
      // the decoded path waited for this — unless the element recovered on its own meanwhile
      if (n.el && !n.el.error && n.el.readyState >= 2 && !n.el.paused) n.deferred = false;
      else fallbackTrack(n);
    }
  }
  // Can the night track be heard right now: its element has decodable data and is playing, or its
  // decoded loop is running.
  function nightReady() {
    const tr = tracks.night;
    if (!tr.url || tr.dead) return false;
    if (tr.fallback) return !!tr.fallback.src;
    return !!(tr.el && !tr.el.paused && !tr.el.error && tr.el.readyState >= 2);
  }
  // equal-power, so the two never dip in the middle of the fade
  function fadeOf(tr) {
    return tr === tracks.night ? NIGHT_TRIM * Math.sin(xfade * Math.PI / 2) : Math.cos(xfade * Math.PI / 2);
  }
  function applyXfade(force) {
    if (!ctx) { xfadeSent = -1; return; }        // before unlock, or after dispose: nothing to drive yet
    if (!force && Math.abs(xfade - xfadeSent) < 0.002) return;
    xfadeSent = xfade;
    for (const tr of [tracks.day, tracks.night]) {
      const g = fadeOf(tr);
      if (tr.fade) tr.fade.gain.setTargetAtTime(g, now(), 0.05);
      else if (tr.node === true && tr.el) { try { tr.el.volume = MUSIC_GAIN * g; } catch (e) { /* ignore */ } }
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
    if (state) curState = state;
    if (events && events.length && ctx && audio.unlocked) {
      // which runes light this frame, so a grab of one does not chime twice
      frameRunes.clear();
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e && e.type === 'rune' && e.holdId != null) frameRunes.add(e.holdId);
      }
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e && e.type) cue(e.type, e);
      }
    }
    if (!state || !ctx || !audio.unlocked) return;
    dt = clamp(+dt || 1 / 60, 0, 0.1);
    updateWind(state, dt);
    updateDuck(dt);
    updateMusic(state, dt);
    updateHeart(state, dt);
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
    for (const tr of [tracks.day, tracks.night]) {
      if (tr.pendingDecode) { tr.pendingDecode = false; fallbackTrack(tr); } else startTrack(tr);
    }
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
      for (const tr of [tracks.day, tracks.night]) if (tr.el && !tr.el.paused) tr.el.pause();
      if (ctx.state === 'running') ctx.suspend().catch(() => {});
    } else {
      if (ctx.state !== 'running') ctx.resume().catch(() => armRetry());
      if (anyWanted() && !audio.muted) startMusic();
    }
  }
  document.addEventListener('visibilitychange', onVisibility);

  // ---- public: music --------------------------------------------------------------------------------------
  // setMusic(url, opts): `url` is the theme; opts.night is the second track (default NIGHT_URL, the
  // file beside it; null for none); opts.decode skips the elements and plays the decoded loops
  // directly (LAN servers without byte-range support, or when an element stays silent on a device).
  // setMusic(null) stops both — the title. Every call is a fresh start: the theme leads, the night
  // track waits under it.
  function setMusic(url, opts = {}) {
    musicUrl = url || null;
    const night = opts.night === undefined ? NIGHT_URL : (opts.night || null);
    setTrack(tracks.day, musicUrl, !!opts.decode);
    setTrack(tracks.night, musicUrl ? night : null, !!opts.decode);
    xfade = 0;
    xfadeTo = 0;
    applyXfade(true);
  }
  function setTrack(tr, url, decode) {
    tr.url = url || null;
    stopFallback(tr);
    tr.deferred = false;
    tr.dead = false;
    if (!tr.url) {
      if (tr.el) tr.el.pause();
      tr.pendingDecode = false;
      return;
    }
    if (decode) {
      if (audio.unlocked) fallbackTrack(tr); else tr.pendingDecode = true;
      return;
    }
    tr.pendingDecode = false;
    if (!tr.el) {
      tr.el = new Audio();
      tr.el.loop = true;
      tr.el.preload = 'auto';
      tr.el.setAttribute('playsinline', '');
      // A server without byte-range support (or a codec quirk) makes iOS refuse the element; the
      // track is then fetched and decoded into a looping buffer instead of staying silent.
      tr.el.addEventListener('error', () => { if (audio.unlocked && tr.url) fallbackTrack(tr); });
    }
    if (tr.el.getAttribute('src') !== tr.url) {
      tr.el.setAttribute('src', tr.url);
      tr.el.load();
    }
    if (audio.unlocked) startTrack(tr);
  }
  function startMusic() {
    startTrack(tracks.day);
    startTrack(tracks.night);
  }
  function ensureBus() {
    if (musicGain) return;
    musicGain = ctx.createGain();
    musicGain.gain.value = 0;
    musicGain.connect(master);
  }
  function startTrack(tr) {
    if (!tr.el || !tr.url || !ctx || !audio.unlocked || audio.muted) return;
    if (tr.fallback) return;   // the decoded loop is already playing (or loading)
    if (!tr.checkTimer) {
      tr.checkTimer = setTimeout(() => {
        tr.checkTimer = 0;
        // eight seconds after the first attempt nothing is decodable: give up on the element
        if (tr.el && tr.url && !tr.fallback && audio.unlocked && (tr.el.readyState < 2 || tr.el.error)) fallbackTrack(tr);
      }, 8000);
    }
    if (!tr.node) {
      try {
        ensureBus();
        tr.node = ctx.createMediaElementSource(tr.el);
        tr.fade = ctx.createGain();
        tr.fade.gain.value = fadeOf(tr);
        tr.node.connect(tr.fade).connect(musicGain);
      } catch (e) {
        // very old engines: fall back to the element's own volume
        tr.node = true;
        try { tr.el.volume = MUSIC_GAIN * fadeOf(tr); } catch (e2) { /* ignore */ }
      }
    }
    if (!tr.el.paused && tr.wanted) return;
    const p = tr.el.play();
    const playing = () => { tr.wanted = true; liftBus(); };
    if (p && p.then) p.then(playing, () => armRetry()); else playing();
  }
  // the bus opens (or re-opens) over 1.6 s once anything is playing
  function liftBus() {
    duckSent = -1;
    if (musicGain) musicGain.gain.setTargetAtTime(MUSIC_GAIN * (1 - DUCK_DEPTH * duck), now(), 1.6);
  }
  function anyWanted() { return tracks.day.wanted || tracks.night.wanted; }
  function trackPlaying(tr) {
    return !!(tr.el && !tr.el.paused && !tr.el.ended) || !!(tr.fallback && tr.fallback.src);
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

  // The decoded path for one track: fetch, decode, loop a buffer through the same fade. The night
  // track's decode is minutes of stereo floats it may never need, so on this path it waits until
  // the fade actually asks for it (switchTo).
  async function fallbackTrack(tr) {
    if (tr.fallback || !ctx || !tr.url) return;
    if (tr === tracks.night && xfadeTo === 0) { tr.deferred = true; return; }
    tr.deferred = false;
    const url = tr.url;
    tr.fallback = { src: null };
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const ab = await ctx.decodeAudioData(await res.arrayBuffer());
      if (!tr.fallback || tr.url !== url || !ctx) return;   // stopped or re-pointed meanwhile
      if (tr.el && !tr.el.paused) tr.el.pause();
      ensureBus();
      if (!tr.fade) {
        tr.fade = ctx.createGain();
        tr.fade.gain.value = fadeOf(tr);
        tr.fade.connect(musicGain);
      }
      const src = ctx.createBufferSource();
      src.buffer = ab;
      src.loop = true;
      src.connect(tr.fade);
      src.start();
      tr.fallback.src = src;
      tr.wanted = true;
      liftBus();
    } catch (err) {
      console.warn('music: element and decoded fallback both failed', tr.name, err);
      tr.fallback = null;
      if (tr === tracks.night) tr.dead = true;   // the climb stays on the theme rather than fading into nothing
    }
  }
  function stopFallback(tr) {
    if (tr.fallback && tr.fallback.src) { try { tr.fallback.src.stop(); } catch (e) { /* ignore */ } }
    tr.fallback = null;
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
      if (tracks.day.el || tracks.night.el) {
        setTimeout(() => {
          if (!audio.muted) return;
          for (const tr of [tracks.day, tracks.night]) if (tr.el && !tr.el.paused) tr.el.pause();
        }, 120);
      }
    } else if (audio.unlocked) {
      startMusic();
    }
  }

  function dispose() {
    for (const ev of gestureEvents) window.removeEventListener(ev, onFirstGesture, true);
    document.removeEventListener('visibilitychange', onVisibility);
    for (const tr of [tracks.day, tracks.night]) {
      if (tr.el) { tr.el.pause(); tr.el.removeAttribute('src'); tr.el.load(); }
      stopFallback(tr);
      clearTimeout(tr.checkTimer);
      tr.checkTimer = 0;
    }
    if (ctx) { try { ctx.close(); } catch (e) { /* ignore */ } }
    ctx = null;
    audio.unlocked = false;
  }

  return audio;
}

export default createAudio;

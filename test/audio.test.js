// src/audio.js against a WebAudio that records instead of playing. There is no sound in node, but
// everything the module promises is visible in the graph it builds: which voices a cue schedules
// and WHEN, which element plays, what the fade and duck gains are told. That is enough to pin what
// B61 and B62 say -- the impact thud is scheduled at the frame's own audio time, a lit rune taken
// again chimes, the night track takes over past night 0.55 and comes back on a new climb, the wind
// still ducks both -- without a browser. It also catches the class of bug B62 started from: a
// voice connected to `null` throws inside the cue and the rest of the sound never happens.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- the fake engine ------------------------------------------------------------------------
class Param {
  constructor(v) { this.value = v; this.calls = []; }
  setValueAtTime(v, t) { this.calls.push(['set', v, t]); this.value = v; return this; }
  linearRampToValueAtTime(v, t) { this.calls.push(['lin', v, t]); return this; }
  exponentialRampToValueAtTime(v, t) { this.calls.push(['exp', v, t]); return this; }
  // the value reads as the target, so a test can ask "what was it last told"
  setTargetAtTime(v, t, tc) { this.calls.push(['target', v, t, tc]); this.value = v; return this; }
  cancelScheduledValues(t) { this.calls.push(['cancel', t]); return this; }
}
class Node {
  constructor(ctx, kind) { this.ctx = ctx; this.kind = kind; this.outputs = []; this.started = null; ctx.nodes.push(this); }
  connect(dst) {
    if (!(dst instanceof Node) && !(dst instanceof Param)) throw new TypeError(`connect: ${dst} is not an AudioNode`);
    this.outputs.push(dst);
    return dst;
  }
  disconnect() {}
  start(when, offset) { this.started = when == null ? this.ctx.currentTime : when; this.offset = offset || 0; }
  stop(when) { this.stopped = when == null ? this.ctx.currentTime : when; }
}
class FakeContext {
  constructor() {
    this.nodes = [];
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.state = 'running';
    this.baseLatency = 0.005;
    this.outputLatency = 0.012;
    this.destination = new Node(this, 'destination');
  }
  createGain() { const n = new Node(this, 'gain'); n.gain = new Param(1); return n; }
  createOscillator() { const n = new Node(this, 'osc'); n.type = 'sine'; n.frequency = new Param(440); n.detune = new Param(0); return n; }
  createBufferSource() { const n = new Node(this, 'buffer'); n.buffer = null; n.loop = false; n.playbackRate = new Param(1); return n; }
  createBiquadFilter() { const n = new Node(this, 'biquad'); n.type = 'lowpass'; n.frequency = new Param(350); n.Q = new Param(1); return n; }
  createDynamicsCompressor() {
    const n = new Node(this, 'comp');
    for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = new Param(0);
    return n;
  }
  createAnalyser() { const n = new Node(this, 'analyser'); n.fftSize = 2048; n.smoothingTimeConstant = 0; n.getFloatTimeDomainData = () => {}; return n; }
  createStereoPanner() { const n = new Node(this, 'panner'); n.pan = new Param(0); return n; }
  createMediaElementSource(el) { const n = new Node(this, 'media'); n.el = el; return n; }
  createBuffer(channels, length, rate) { const data = new Float32Array(length); return { length, sampleRate: rate, duration: length / rate, getChannelData: () => data }; }
  async decodeAudioData() { return { duration: 10, length: 480000, sampleRate: 48000 }; }
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  async close() { this.state = 'closed'; }
}
class FakeAudio {
  constructor() {
    FakeAudio.all.push(this);
    this.attrs = {}; this.paused = true; this.ended = false; this.currentTime = 0; this.duration = NaN;
    this.readyState = 4; this.error = null; this.loop = false; this.preload = ''; this.volume = 1;
    this.plays = 0; this.loads = 0; this.listeners = {};
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  load() { this.loads++; }
  play() { this.plays++; this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  removeEventListener() {}
}
FakeAudio.all = [];
const fetches = [];
globalThis.window = { AudioContext: FakeContext, addEventListener() {}, removeEventListener() {} };
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.Audio = FakeAudio;
globalThis.fetch = async (url) => { fetches.push(url); return { ok: true, arrayBuffer: async () => new ArrayBuffer(16) }; };

const { createAudio } = await import('../src/audio.js');

// ---- helpers ---------------------------------------------------------------------------------
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);
const flush = () => new Promise((r) => setImmediate(r));
function climb(o = {}) {
  return {
    phase: 'climbing', night: 0.1, height: 3, t: 1,
    body: { x: 0, y: 3, vx: 0, vy: 0 },
    hands: { L: { stamina: 1, gripping: true }, R: { stamina: 1, gripping: true } },
    route: { top: 24, holds: [{ id: 1, kind: 'rune' }, { id: 2, kind: 'hold' }] },
    ...o,
  };
}
function boot() {
  FakeAudio.all.length = 0;
  fetches.length = 0;
  const audio = createAudio();
  assert.equal(audio.unlock(), true);
  return { audio, ctx: audio.ctx };
}
function run(audio, state, seconds, dt = 1 / 60) {
  for (let t = 0; t < seconds - 1e-9; t += dt) audio.handle([], state, dt);
}
// every node a call created that was also started -- the voices of a cue
function voicesOf(ctx, fn) {
  const before = ctx.nodes.length;
  fn();
  return ctx.nodes.slice(before).filter((n) => n.started != null);
}
function quiet(fn) {
  const warns = [];
  const w = console.warn;
  console.warn = (...a) => warns.push(a.map(String).join(' '));
  try { fn(); } finally { console.warn = w; }
  return warns;
}
// the media source → fade gain → bus chain for one element
function chainOf(ctx, el) {
  const src = ctx.nodes.find((n) => n.kind === 'media' && n.el === el);
  assert.ok(src, 'the element is on the graph');
  const fade = src.outputs[0];
  assert.equal(fade.kind, 'gain');
  return { src, fade, bus: fade.outputs[0] };
}

// ---- B62: the cues ---------------------------------------------------------------------------
test('audio: the impact cue lands the frame it is handled, scheduled at the current audio time (B62, B53)', () => {
  const { audio, ctx } = boot();
  ctx.currentTime = 12.5;
  let voices;
  const warns = quiet(() => {
    voices = voicesOf(ctx, () => audio.handle([{ type: 'impact' }, { type: 'fallen' }], climb({ phase: 'fallen', night: 0 }), 1 / 60));
  });
  assert.deepEqual(warns, [], 'no voice of the cue threw');
  const thud = voices.find((n) => n.kind === 'osc' && n.frequency.value === 90);
  assert.ok(thud, 'the thud is the 90 Hz sine');
  assert.equal(thud.started, 12.5, 'scheduled at ctx.currentTime, not a frame later');
  assert.equal(thud.outputs[0].outputs[0].kind, 'gain', 'the thud reaches the master bus');
  const scatter = voices.filter((n) => n.kind === 'buffer' && n.started > 12.5 && n.started <= 13.1);
  assert.ok(scatter.length >= 6, `a rock-scatter tail follows the hit (${scatter.length} late voices)`);
  assert.ok(voices.every((n) => n.started >= 12.5 && n.started < 13.2), 'nothing is scheduled in the past or long after');
  assert.equal(audio.debug().lastCue.type, 'impact');
  assert.equal(audio.debug().lastCue.at, 12.5);
  audio.dispose();
});

test('audio: crumble, grab, rune and fall are keyed on the event names and all schedule voices (B62)', () => {
  const { audio, ctx } = boot();
  const st = climb();
  for (const e of [{ type: 'crumble', hand: 'L', holdId: 10001 }, { type: 'grab', hand: 'R', holdId: 2 }, { type: 'rune', hand: 'R', holdId: 1 }, { type: 'fall' }]) {
    let voices;
    const warns = quiet(() => { voices = voicesOf(ctx, () => audio.handle([e], st, 1 / 60)); });
    assert.deepEqual(warns, [], `${e.type}: no voice threw`);
    assert.ok(voices.length >= 2, `${e.type}: ${voices.length} voices scheduled`);
    assert.ok(voices.every((n) => n.started >= ctx.currentTime), `${e.type}: nothing in the past`);
  }
  const unknown = voicesOf(ctx, () => audio.handle([{ type: 'fallen' }, { type: 'nothing-of-the-sort' }], st, 1 / 60));
  assert.equal(unknown.length, 0, 'events without a cue are silent, not errors');
  audio.dispose();
});

test('audio: taking a lit rune again chimes softly; its first lighting and a plain hold do not add one (B62)', () => {
  const { audio, ctx } = boot();
  const st = climb();
  const bells = (voices) => voices.filter((n) => n.kind === 'osc' && Math.abs(n.frequency.value - 660) < 3).length;
  // the checkpoint, taken again: the grab carries the chime
  assert.equal(bells(voicesOf(ctx, () => audio.handle([{ type: 'grab', hand: 'L', holdId: 1 }], st))), 1);
  // the first time it lights, the rune cue is the answer and the grab stays quiet: one bell, not two
  assert.equal(bells(voicesOf(ctx, () => audio.handle([{ type: 'grab', hand: 'L', holdId: 1 }, { type: 'rune', hand: 'L', holdId: 1 }], st))), 1);
  // plain rock
  assert.equal(bells(voicesOf(ctx, () => audio.handle([{ type: 'grab', hand: 'R', holdId: 2 }], st))), 0);
  // a hold the route does not know (a decoy id) is plain rock too
  assert.equal(bells(voicesOf(ctx, () => audio.handle([{ type: 'grab', hand: 'R', holdId: 10001 }], st))), 0);
  audio.dispose();
});

// ---- B61: the second track ----------------------------------------------------------------------
test('audio: past night 0.55 the night track fades in over 2 s, and a new climb fades the theme back (B61)', async () => {
  const { audio, ctx } = boot();
  audio.setMusic('http://x/theme.mp3', { night: 'http://x/theme2.mp3' });
  await flush();
  const [day, night] = FakeAudio.all;
  assert.equal(day.getAttribute('src'), 'http://x/theme.mp3');
  assert.equal(night.getAttribute('src'), 'http://x/theme2.mp3');
  assert.ok(day.plays >= 1 && night.plays >= 1, 'both elements are played from the start gesture, the night one silently');
  assert.ok(day.loop && night.loop);
  const a = chainOf(ctx, day), b = chainOf(ctx, night);
  const trim = audio.debug().nightTrim;      // the night track's level match, applied in its fade
  assert.equal(a.bus, b.bus, 'both tracks feed the one bus the wind ducks');
  assert.equal(a.bus.outputs[0].kind, 'gain', 'and the bus feeds master');
  assert.equal(a.fade.gain.value, 1);
  assert.equal(b.fade.gain.value, 0);
  assert.equal(audio.debug().track, 'day');
  assert.equal(audio.debug().music.playing, true);
  assert.equal(audio.debug().night.playing, true);

  // under the threshold nothing moves
  run(audio, climb({ night: 0.5 }), 1);
  assert.equal(audio.debug().track, 'day');
  assert.equal(audio.debug().xfade, 0);

  // over it: a 2 s equal-power fade
  const up = climb({ night: 0.6 });
  run(audio, up, 0.5);
  assert.equal(audio.debug().track, 'night');
  near(audio.debug().xfade, 0.25, 0.02, 'a quarter of the way after 0.5 s');
  near(b.fade.gain.value, trim * Math.sin(0.25 * Math.PI / 2), 0.05, 'night gain');
  near(a.fade.gain.value, Math.cos(0.25 * Math.PI / 2), 0.03, 'theme gain');
  run(audio, up, 1.6);
  assert.equal(audio.debug().xfade, 1);
  near(b.fade.gain.value, trim, 1e-9);
  near(a.fade.gain.value, 0, 1e-9);

  // the plunge runs night back to 0 on the way down, and the ground is not a new climb
  run(audio, climb({ phase: 'falling', night: 0.2, body: { x: 0, y: 5, vx: 0, vy: -20 } }), 1);
  assert.equal(audio.debug().track, 'night', 'still the night track through the fall');
  run(audio, climb({ phase: 'fallen', night: 0 }), 1);
  assert.equal(audio.debug().track, 'night', 'and on the ground');
  assert.equal(audio.debug().xfade, 1);

  // Climb again: a fresh state at the foot, and the theme comes back over the same 2 s
  run(audio, climb({ night: 0.05 }), 1);
  assert.equal(audio.debug().track, 'day');
  near(audio.debug().xfade, 0.5, 0.02, 'halfway back after 1 s');
  run(audio, climb({ night: 0.05 }), 1.2);
  assert.equal(audio.debug().xfade, 0);
  assert.equal(a.fade.gain.value, 1);
  assert.equal(b.fade.gain.value, 0);
  audio.dispose();
});

test('audio: setMusic(null) is the title and stops both; mute pauses both; theme2.mp3 beside the theme is the default (B61)', async () => {
  const { audio } = boot();
  audio.setMusic('http://x/theme.mp3');
  await flush();
  const [day, night] = FakeAudio.all;
  assert.ok(night.getAttribute('src').endsWith('/assets/audio/theme2.mp3'), night.getAttribute('src'));
  run(audio, climb({ night: 0.7 }), 2.5);
  assert.equal(audio.debug().track, 'night');

  audio.setMusic(null);
  assert.ok(day.paused && night.paused, 'the title is silent');
  assert.equal(audio.debug().music.playing, false);
  assert.equal(audio.debug().music.url, null);
  assert.equal(audio.debug().track, 'day');
  assert.equal(audio.debug().xfade, 0, 'and the next climb starts on the theme');

  audio.setMusic('http://x/theme.mp3');
  await flush();
  assert.ok(!day.paused && !night.paused, 'Tap to begin plays both again');
  assert.equal(day.loads, 1, 'the same src is not reloaded');

  audio.setMuted(true);
  await new Promise((r) => setTimeout(r, 160));
  assert.ok(day.paused && night.paused, 'mute pauses both elements');
  audio.setMuted(false);
  await flush();
  assert.ok(!day.paused && !night.paused, 'unmute plays both');

  audio.setMusic('http://x/theme.mp3', { night: null });
  await flush();
  assert.ok(!day.paused && night.paused, 'night: null is one track only');
  run(audio, climb({ night: 0.9 }), 1);
  assert.equal(audio.debug().track, 'day', 'and nothing to switch to');
  audio.dispose();
});

test('audio: the wind still ducks the music, on the bus both tracks share (B26 under B61)', async () => {
  const { audio } = boot();
  audio.setMusic('http://x/theme.mp3');
  await flush();
  near(audio.debug().music.gain, 0.35, 1e-6, 'the bus opens to MUSIC_GAIN');
  run(audio, climb({ phase: 'falling', night: 0.6, body: { x: 0, y: 10, vx: 0, vy: -22 } }), 1);
  assert.ok(audio.debug().duck > 0.95, `the plunge saturates the duck (${audio.debug().duck})`);
  assert.ok(audio.debug().music.gain < 0.1, `and the bus is a quarter of full (${audio.debug().music.gain})`);
  run(audio, climb({ night: 0.6 }), 5);
  assert.ok(audio.debug().music.gain > 0.33, `and comes back once the wind dies (${audio.debug().music.gain})`);
  audio.dispose();
});

test('audio: on the decoded path the night track is not fetched until the fade asks for it (B61)', async () => {
  const { audio, ctx } = boot();
  audio.setMusic('http://x/theme.mp3', { night: 'http://x/theme2.mp3', decode: true });
  await flush(); await flush();
  assert.deepEqual(fetches, ['http://x/theme.mp3'], 'only the theme is decoded up front');
  assert.equal(FakeAudio.all.length, 0, 'no elements on this path');
  assert.equal(audio.debug().music, null);
  const loops = () => ctx.nodes.filter((n) => n.kind === 'buffer' && n.loop && n.started != null && n.buffer && n.buffer.duration === 10);
  assert.equal(loops().length, 1, 'the theme loops from a buffer');
  run(audio, climb({ night: 0.6 }), 0.1);
  await flush(); await flush();
  assert.deepEqual(fetches, ['http://x/theme.mp3', 'http://x/theme2.mp3'], 'the switch fetches the night track');
  assert.equal(loops().length, 2, 'and it loops from a buffer of its own');
  const [a, b] = loops();
  assert.equal(a.outputs[0].outputs[0], b.outputs[0].outputs[0], 'through the same bus');
  audio.setMusic(null);
  assert.ok(a.stopped != null && b.stopped != null, 'the title stops both loops');
  audio.dispose();
});

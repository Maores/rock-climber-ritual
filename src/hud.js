// hud.js — Rock Climber: The Ritual
// Shell, HUD, title and end screens. Owns every DOM node under #hud, #title, #end and the #mute button.
// The single export is createHud(root); see CONTRACTS.md, section "hud-audio".
//
// Conventions used here:
//   • hud.update(state) is called every rendered frame, so every DOM write is guarded by a cache
//     and only happens when the displayed value actually changes.
//   • hud.setStick(side, x, y) receives the stick vector in the unit disc with +y = up (world convention);
//     the knob is translated by (x, -y) in screen space.
//   • Messages dedupe on text, so the integrator and this module can both announce the same moment
//     without a double flash.
//
// Integration notes for main.js (everything beyond CONTRACTS.md is optional):
//   • hud.update(state[, events]) — the event list is optional; misses are also detected from state.
//   • hud.onMute(cb) wires the mute button to audio.setMuted; without it the button reaches
//     window.__ritual.audio. hud.onRestart(cb) replaces the default location.reload() of "Climb again".
//   • hud.onMenu(cb) is asked to put the game back on the title screen; without it Menu reloads the
//     page. hud.onPause(cb) fires true/false around the mid-climb confirmation, so the integrator
//     can freeze the sim while the question is on screen.
//   • hud.showEnd(stats) accepts the state object or { time, high, runesLit, runesTotal }; the HUD
//     also shows the end screen itself 2.8 s after state.phase becomes 'summit' unless it was shown.
//   • The keystroke that starts the climb is stopped in the capture phase on window, so input.js never
//     sees it as a grip toggle; pointer starts never reach the sticks (the overlay is above them).

import { SPIDER_CODE, spiderUnlocked, unlockSpider, spiderSkin, setSpiderSkin } from './spiderHand.js';

const MUTE_KEY = 'ritual.muted';
const ARC_R = 63;                              // radius of the SVG stamina arc in index.html
const ARC_C = 2 * Math.PI * ARC_R;

const PILL_LABEL = {
  free: 'Grip',
  hover: 'Grab',
  armed: 'Armed',
  gripping: 'Holding',
  slipping: 'Slipping',
};

// B39: on a pointer device the pill also carries an LMB / RMB badge, and a letter-spaced
// eight-letter word plus a badge does not fit the pill at any size the layout produces. HELD
// rather than HOLD because the badge is beside it: the mouse button is a toggle, not a hold.
const PILL_LABEL_KEYED = {
  free: 'Grip',
  hover: 'Grab',
  armed: 'Armed',
  gripping: 'Held',
  slipping: 'Slip',
};

// B42: what each of the four routes actually is, from the numbers B13 measured when it picked
// them. Keyed by seed, because generation is deterministic and a seed IS the route; route.js
// owns the roster itself, so nothing here has to agree with it beyond the number.
const ROUTE_LINE = {
  7: 'The original line.',
  21: '42 jugs, easy rock low down, poor rock up high.',
  4: 'Wanders 0.70 m either side of centre.',
  19: '31 crimps, 18 slopers, 68% poor rock up high. 9 decoys.',
};
const UNLISTED_LINE = 'An unlisted seed.';

const CREDITS = [
  {
    what: 'Hand model',
    text: '“Realistic Hand” by J-Toastie via Poly Pizza',
    license: 'CC-BY 3.0',
    url: 'https://poly.pizza/m/2lEkhDqfQf',
  },
  {
    what: 'Music',
    text: '“Ritual” Kevin MacLeod (incompetech.com)',
    license: 'Licensed under Creative Commons: By Attribution 4.0',
    url: 'https://creativecommons.org/licenses/by/4.0/',
  },
  {
    what: 'Rock, holds and sky',
    text: 'rock_face_03, rock_boulder_dry and kloppenheim_06_puresky by Poly Haven',
    license: 'CC0',
    url: 'https://polyhaven.com',
  },
  {
    what: 'Engine',
    text: 'three.js',
    license: 'MIT',
    url: 'https://threejs.org',
  },
];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function readMuted() {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { return false; }
}
function writeMuted(b) {
  try { localStorage.setItem(MUTE_KEY, b ? '1' : '0'); } catch (e) { /* private mode: ignore */ }
}

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function createHud(root) {
  const doc = root && root.nodeType === 9 ? root : (root && root.ownerDocument) || document;
  const scope = root && root.nodeType === 1 ? root : doc.body;
  const byId = (id) => doc.getElementById(id);
  const ensure = (id, tag, parent, cls) => {
    let el = byId(id);
    if (!el) {
      el = doc.createElement(tag);
      el.id = id;
      if (cls) el.className = cls;
      parent.appendChild(el);
    }
    return el;
  };

  // ---- resolve or build the DOM ---------------------------------------------------------------
  const hudEl = ensure('hud', 'div', scope);
  const titleEl = ensure('title', 'div', scope, 'overlay');
  const endEl = ensure('end', 'div', scope, 'overlay');
  const msgEl = ensure('msg', 'div', hudEl);
  const vigEl = ensure('vig', 'div', hudEl);
  const flashEl = ensure('fallflash', 'div', hudEl);
  let topEl = byId('top');
  if (!topEl) {
    topEl = doc.createElement('div');
    topEl.id = 'top';
    topEl.innerHTML = '<div id="falls" hidden></div><div id="meter"><div id="height">0.0<small>m</small></div><div id="runes"></div></div><div></div>';
    hudEl.insertBefore(topEl, msgEl);
  }
  const heightEl = ensure('height', 'div', byId('meter') || topEl);
  const runesEl = ensure('runes', 'div', byId('meter') || topEl);
  // B43: the rope is gone, so a fall ends the climb and a counter of them can only ever read 0.
  const fallsEl = ensure('falls', 'div', topEl);
  fallsEl.hidden = true;
  if (!heightEl.querySelector('small')) heightEl.innerHTML = '0.0<small>m</small>';
  const heightText = heightEl.firstChild; // the text node before <small>

  function ensureCluster(side) {
    const s = side.toLowerCase();
    let ctl = byId('ctl-' + s);
    if (!ctl) {
      ctl = doc.createElement('div');
      ctl.id = 'ctl-' + s;
      ctl.className = 'ctl';
      hudEl.appendChild(ctl);
    }
    let grip = byId('grip-' + s);
    if (!grip) {
      grip = doc.createElement('button');
      grip.id = 'grip-' + s;
      grip.type = 'button';
      grip.className = 'grip';
      grip.textContent = 'Grip';
      ctl.appendChild(grip);
    }
    let stick = byId('stick-' + s);
    if (!stick) {
      stick = doc.createElement('div');
      stick.id = 'stick-' + s;
      stick.className = 'stick';
      ctl.appendChild(stick);
    }
    if (!stick.querySelector('svg')) {
      stick.insertAdjacentHTML('afterbegin',
        '<svg viewBox="0 0 136 136"><circle class="track" cx="68" cy="68" r="63"/><circle class="arc" cx="68" cy="68" r="63"/></svg>' +
        '<span class="side">' + side + '</span>');
    }
    let knob = stick.querySelector('.knob');
    if (!knob) {
      knob = doc.createElement('div');
      knob.className = 'knob';
      stick.appendChild(knob);
    }
    const arc = stick.querySelector('.arc');
    arc.style.strokeDasharray = ARC_C.toFixed(2);
    arc.style.strokeDashoffset = '0';
    return { ctl, grip, stick, knob, arc };
  }
  const parts = { L: ensureCluster('L'), R: ensureCluster('R') };

  const sticks = { L: parts.L.stick, R: parts.R.stick };
  const grips = { L: parts.L.grip, R: parts.R.grip };

  // ---- per-frame caches --------------------------------------------------------------------------
  const cache = {
    height: null,
    high: null,
    runesLit: -1,
    runesTotal: -1,
    runeIds: '',
    phase: null,
    vig: -1,
    beat: null,
    summitLit: null,
    hudOn: false,
    falling: false,
  };
  const armState = { L: { stamina: -1, cls: '' }, R: { stamina: -1, cls: '' } };
  const pillState = { L: '', R: '' };
  const armedNow = { L: false, R: false };
  const knobState = { L: { x: 0, y: 0, active: false }, R: { x: 0, y: 0, active: false } };
  let knobRadius = 0;
  let runeDots = [];
  let summitDot = null;

  function measure() {
    const s = sticks.L.offsetWidth || 136;
    const k = (parts.L.knob.offsetWidth || 56);
    knobRadius = Math.max(10, (s - k) / 2);
  }
  measure();
  const onResize = () => { measure(); applyKnob('L'); applyKnob('R'); };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  let bootGone = false;
  function dismissBoot() {
    if (bootGone) return;
    bootGone = true;
    const boot = byId('boot');
    if (!boot) return;
    boot.classList.add('hide');
    setTimeout(() => { boot.hidden = true; }, 900);
  }
  function showHud() {
    if (cache.hudOn) return;
    dismissBoot();
    cache.hudOn = true;
    hudEl.classList.add('on');
    hudEl.setAttribute('aria-hidden', 'false');
    if (menuBtn) menuBtn.hidden = false;     // B40: the Menu button is up exactly while a climb is
    // fonts and layout are ready only now; re-measure once the frame is painted
    requestAnimationFrame(onResize);
  }
  function hideHud() {
    cache.hudOn = false;
    hudEl.classList.remove('on');
    hudEl.setAttribute('aria-hidden', 'true');
    if (menuBtn) menuBtn.hidden = true;
  }

  // ---- the way back to the title (B40) ----------------------------------------------------
  // Every choice on the title screen used to be a one-way door. The button lives with the HUD, so
  // it is up exactly while a climb is: mid-climb it asks once, because a mis-tap would throw the
  // climb away; from the end screen there is nothing left to lose and it just goes. Rebuilding the
  // game is the integrator's business — all this does is ask and report.
  const menuBtn = byId('menuBtn');
  const confirmEl = byId('confirm');
  const menuCbs = [];
  const pauseCbs = [];
  function onMenu(cb) {
    if (typeof cb === 'function') menuCbs.push(cb);
    return hud;
  }
  function onPause(cb) {
    if (typeof cb === 'function') pauseCbs.push(cb);
    return hud;
  }
  function setPaused(on) {
    for (const cb of pauseCbs) { try { cb(!!on); } catch (err) { console.error(err); } }
  }
  function openConfirm() {
    if (!confirmEl) { leaveClimb(); return; }        // no markup: ask nothing rather than trap them
    confirmEl.hidden = false;
    syncOverlayFlag();
    setPaused(true);                                 // a one-hand hang drains 0.20/s: the question must not cost the climb
  }
  function closeConfirm() {
    if (!confirmEl || confirmEl.hidden) return;
    confirmEl.hidden = true;
    syncOverlayFlag();
    setPaused(false);
  }
  function leaveClimb() {
    closeConfirm();
    if (menuCbs.length) {
      for (const cb of menuCbs) { try { cb(); } catch (err) { console.error(err); } }
    } else {
      location.reload();                             // not wired: a reload is the title screen
    }
  }
  const onMenuClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Falling, or on the ground: the climb is already lost, so "Leave the climb?" would be asking
    // about something that has happened. Go straight out, and never freeze a fall to ask.
    if (cache.phase === 'falling' || cache.phase === 'fallen') leaveClimb();
    else openConfirm();
  };
  const onConfirmBackdrop = (e) => { if (e.target === confirmEl) closeConfirm(); };
  const confirmStayEl = byId('confirmStay');
  const confirmLeaveEl = byId('confirmLeave');
  if (menuBtn) menuBtn.addEventListener('click', onMenuClick);
  if (confirmEl) {
    if (confirmStayEl) confirmStayEl.addEventListener('click', closeConfirm);
    if (confirmLeaveEl) confirmLeaveEl.addEventListener('click', leaveClimb);
    confirmEl.addEventListener('pointerdown', onConfirmBackdrop);
  }
  const onConfirmKey = (e) => {
    if (!confirmEl || confirmEl.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeConfirm(); }
  };
  window.addEventListener('keydown', onConfirmKey);

  // ---- sticks -----------------------------------------------------------------------------------
  function applyKnob(side) {
    const k = knobState[side];
    parts[side].knob.style.transform = 'translate(' + (k.x * knobRadius).toFixed(1) + 'px,' + (-k.y * knobRadius).toFixed(1) + 'px)';
  }
  function setStick(side, x, y) {
    const p = parts[side];
    if (!p) return;
    x = +x || 0; y = +y || 0;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    const k = knobState[side];
    if (Math.abs(k.x - x) < 0.002 && Math.abs(k.y - y) < 0.002) return;
    k.x = x; k.y = y;
    applyKnob(side);
    const active = len > 0.04;
    if (active !== k.active) {
      k.active = active;
      p.stick.classList.toggle('active', active);
    }
  }

  // ---- stamina arcs -------------------------------------------------------------------------------
  function setArc(side, stamina) {
    const st = armState[side];
    const s = clamp01(stamina == null ? 1 : stamina);
    if (Math.abs(s - st.stamina) > 0.0015 || st.stamina < 0) {
      st.stamina = s;
      parts[side].arc.style.strokeDashoffset = (ARC_C * (1 - s)).toFixed(2);
    }
    const cls = s < 0.25 ? 'crit' : s < 0.5 ? 'low' : '';
    if (cls !== st.cls) {
      st.cls = cls;
      parts[side].arc.setAttribute('class', 'arc' + (cls ? ' ' + cls : ''));
      parts[side].stick.classList.toggle('crit', cls === 'crit');
    }
  }

  // ---- GRIP pills -----------------------------------------------------------------------------------
  function pillFor(hand) {
    if (!hand) return 'free';
    if (hand.gripping) return hand.stamina < 0.2 ? 'slipping' : 'gripping';
    if (hand.armed) return 'armed';
    if ((hand.hover || 0) > 0.5) return 'hover';
    return 'free';
  }
  let keyHints = null; // { L: 'LMB', R: 'RMB' } on a pointer device: the two mouse buttons are the grips
  function setPill(side, st) {
    if (pillState[side] === st) return;
    pillState[side] = st;
    const el = grips[side];
    const keep = el.classList.contains('miss') ? ' miss' : '';
    el.className = 'grip ' + st + keep + (keyHints ? ' keyed' : '');
    el.textContent = (keyHints ? PILL_LABEL_KEYED : PILL_LABEL)[st] || 'Grip';
    if (keyHints) {
      const k = doc.createElement('span');
      k.className = 'key';
      k.textContent = keyHints[side];
      el.appendChild(k);
    }
  }
  function shake(side) {
    const el = grips[side];
    if (!el) return;
    el.classList.remove('miss');
    // restart the animation even if a previous shake is still running
    void el.offsetWidth;
    el.classList.add('miss');
    setTimeout(() => el.classList.remove('miss'), 400);
  }

  // ---- rune progress ----------------------------------------------------------------------------------
  function buildRuneDots(route) {
    const holds = (route && route.holds) || [];
    const runes = holds.filter((h) => h.kind === 'rune').sort((a, b) => a.y - b.y);
    const ids = runes.map((h) => h.id).join(',');
    if (ids === cache.runeIds && runeDots.length) return runes;
    cache.runeIds = ids;
    runesEl.innerHTML = '';
    runeDots = runes.map((h) => {
      const d = doc.createElement('span');
      d.className = 'dot';
      d.dataset.hold = h.id;
      runesEl.appendChild(d);
      return d;
    });
    summitDot = doc.createElement('span');
    summitDot.className = 'dot summit';
    summitDot.title = 'Summit altar';
    runesEl.appendChild(summitDot);
    cache.runesTotal = runes.length;
    return runes;
  }
  function updateRunes(state) {
    const runes = buildRuneDots(state.route);
    const litIds = state.runesLit || [];
    let lit = 0;
    for (let i = 0; i < runes.length; i++) {
      const h = runes[i];
      const isLit = !!h.lit || litIds.indexOf(h.id) !== -1;
      if (isLit) lit++;
      const dot = runeDots[i];
      if (dot && dot.classList.contains('lit') !== isLit) {
        dot.classList.toggle('lit', isLit);
        if (isLit && cache.runesLit >= 0) {
          dot.classList.remove('pop');
          void dot.offsetWidth;
          dot.classList.add('pop');
        }
      }
    }
    const summitLit = state.phase === 'summit';
    if (summitDot && summitLit !== cache.summitLit) {
      cache.summitLit = summitLit;
      summitDot.classList.toggle('lit', summitLit);
    }
    if (lit !== cache.runesLit) {
      if (cache.runesLit >= 0 && lit > cache.runesLit && state.phase !== 'summit') {
        message('Rune ' + lit + ' of ' + runes.length + ' · rest here', 1800, 'rune');
      }
      cache.runesLit = lit;
    }
  }

  // ---- messages -----------------------------------------------------------------------------------------
  let msgTimer = 0;
  let msgText = '';
  function message(text, ms = 2200, tone = '') {
    clearTimeout(msgTimer);
    if (text !== msgText || !msgEl.classList.contains('show')) {
      msgEl.textContent = text;
      msgText = text;
    }
    msgEl.className = 'show' + (tone ? ' ' + tone : '');
    msgTimer = setTimeout(() => {
      msgEl.classList.remove('show');
      msgText = '';
    }, Math.max(300, ms | 0));
  }

  // ---- phase-driven moments --------------------------------------------------------------------------------
  let endShown = false;
  let endTimer = 0;
  function onPhase(prev, next, state) {
    if (next === 'falling') {
      hudEl.classList.add('falling');
    } else if (prev === 'falling') {
      hudEl.classList.remove('falling');
    }
    if (next === 'climbing' && (prev === 'title' || prev === null)) {
      message('Light every rune · reach the altar', 3000);
    } else if (next === 'summit') {
      message('The ritual is complete', 3400, 'rune');
      clearTimeout(endTimer);
      endTimer = setTimeout(() => { if (!endShown) showEnd(state); }, 2800);
    } else if (next === 'fallen') {
      // The ground. Let the impact land before anything is asked of the player.
      if (hudEl && hudEl.classList) hudEl.classList.add('dead');
      message('The cliff keeps you', 3200, 'warn');
      clearTimeout(endTimer);
      endTimer = setTimeout(() => { if (!endShown) showEnd(state); }, 2400);
    }
  }

  // ---- update -----------------------------------------------------------------------------------------------
  function update(state, events) {
    if (!state) return;
    updateWeb(state);
    if (state.phase !== 'title' && !cache.hudOn && !endShown) showHud();

    const hands = state.hands || {};
    const L = hands.L, R = hands.R;
    setArc('L', L ? L.stamina : 1);
    setArc('R', R ? R.stamina : 1);
    setPill('L', pillFor(L));
    setPill('R', pillFor(R));
    // A hand that just became armed tapped GRIP away from every hold: that is the "miss" the sim
    // reports, so shake the pill even when the integrator does not pass the event list.
    for (const side of ['L', 'R']) {
      const hand = hands[side];
      const armed = !!(hand && hand.armed && !hand.gripping);
      if (armed && !armedNow[side]) shake(side);
      armedNow[side] = armed;
    }

    const h = Math.max(0, +state.height || 0).toFixed(1);
    if (h !== cache.height) {
      cache.height = h;
      heightText.nodeValue = h;
    }

    updateRunes(state);

    // low-stamina vignette: creeps in under 35 %, pulses with the heartbeat under 25 % while hanging
    const minS = Math.min(L ? L.stamina : 1, R ? R.stamina : 1);
    const danger = state.phase === 'climbing' ? clamp01((0.35 - minS) / 0.35) : 0;
    const vig = Math.round(danger * 100) / 100;
    if (vig !== cache.vig) {
      cache.vig = vig;
      vigEl.style.opacity = vig;
    }
    const beat = danger > 0 && minS < 0.25 && !!((L && L.gripping) || (R && R.gripping));
    if (beat !== cache.beat) {
      cache.beat = beat;
      vigEl.classList.toggle('beat', beat);
    }

    if (state.phase !== cache.phase) {
      const prev = cache.phase;
      cache.phase = state.phase;
      onPhase(prev, state.phase, state);
    }

    if (events && events.length) {
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.type === 'miss' && e.hand) shake(e.hand);
      }
    }
  }

  // ---- title screen ---------------------------------------------------------------------------------------------
  const startCbs = [];
  let titleShown = false;
  let started = false;

  // The WEB pad belongs to the climb, so it goes away whenever a full-screen overlay is up: it
  // used to sit on top of the title's tap line in landscape and over the end screen's credits.
  function syncOverlayFlag() {
    const up = titleShown || endShown || !!(customEl && !customEl.hidden) || !!(confirmEl && !confirmEl.hidden);
    if (doc.body && doc.body.classList) doc.body.classList.toggle('overlay-up', up);
  }

  function controlsHtml(touch) {
    if (touch) {
      // a picture of the two thumb clusters: the left one pushes its stick, the right one holds
      const ring = (push, dash) =>
        '<span class="mini-ring' + (push ? ' push' : '') + '"><svg viewBox="0 0 54 54"><circle cx="27" cy="27" r="25.5" style="stroke-dashoffset:' + dash + '"/></svg><i></i></span>';
      return (
        '<h2>How to climb</h2>' +
        '<div class="demo">' +
        '<div class="mini"><span class="mini-pill">Grip</span>' + ring(true, 12) + '<b>Left</b></div>' +
        '<div class="steps">' +
        '<p><span class="n">1</span><span class="tx"><em>Push a stick</em> — that hand reaches for a hold.</span></p>' +
        '<p><span class="n">2</span><span class="tx"><em>Tap GRIP</em> to grab it. Tap again to let go.</span></p>' +
        '<p><span class="n">3</span><span class="tx">Climb hand over hand and <em>rest on the glowing runes</em>.</span></p>' +
        '</div>' +
        '<div class="mini"><span class="mini-pill lit">Holding</span>' + ring(false, 58) + '<b>Right</b></div>' +
        '</div>' +
        '<p class="hint">Hanging drains a hand — the arc around its stick shows how much is left. <b>Nothing catches you</b>, and not every rock holds. <b>Drag to look around.</b></p>'
      );
    }
    return (
      '<h2>How to climb</h2>' +
      '<div class="row">' +
      '<div class="hand"><b>Left hand</b><div class="keys"><kbd>Left click</kbd><span class="sep">grip / let go</span></div></div>' +
      '<div class="hand"><b>Right hand</b><div class="keys"><kbd>Right click</kbd><span class="sep">grip / let go</span></div></div>' +
      '<p class="hint"><em>Move the mouse</em> and the hand that is hanging free follows it. Let a hand go, point where you want it, click again to take the rock. <em>Shift-drag</em> to look around — the view stays where you leave it.</p>' +
      '</div>' +
      '<p class="hint">Hanging drains a hand — rest on the <i>glowing runes</i>. <b>Nothing catches you</b>: one fall is the whole cliff. Not every rock holds. <kbd>M</kbd> mutes.</p>'
    );
  }
  function footHtml() {
    return CREDITS.slice(0, 3).map((c) => escapeHtml(c.text) + ' (' + escapeHtml(c.license.replace('Licensed under Creative Commons: By Attribution 4.0', 'CC BY 4.0')) + ')').join(' · ');
  }

  // ---- the route picker -------------------------------------------------------------------
  // Generation is deterministic per seed, so a seed is a route. The integrator hands over the
  // hand-checked roster and which one is loaded; picking a different one is its business (it
  // means rebuilding the cliff), so all this does is report the choice.
  const seedCbs = [];
  function onSeed(cb) {
    if (typeof cb === 'function') seedCbs.push(cb);
    return hud;
  }
  // B42: the shared line under the pills. It describes the route you are on; pointing at or
  // tabbing to another pill previews that one, so the sentence answers the question before the
  // tap that reloads the page rather than after it.
  let seedNow = null;
  function setNote(seed) {
    const el = byId('seed-note');
    if (el) el.textContent = ROUTE_LINE[seed] || UNLISTED_LINE;
  }
  function previewNote(e) {
    const b = e.target && e.target.closest ? e.target.closest('[data-seed]') : null;
    if (b) setNote(+b.getAttribute('data-seed'));
  }
  function renderSeeds(list, current) {
    const inner = titleEl.querySelector('.inner');
    let row = byId('seeds');
    if (!Array.isArray(list) || !list.length) { if (row) row.remove(); return; }
    if (!row) {
      row = doc.createElement('div');
      row.id = 'seeds';
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', 'Choose a route');
      // a pointer on a route pill picks a route; it must not also start the climb
      row.addEventListener('pointerdown', (e) => e.stopPropagation());
      row.addEventListener('click', (e) => {
        const b = e.target && e.target.closest ? e.target.closest('button[data-seed]') : null;
        if (!b) return;
        e.stopPropagation();
        const n = +b.getAttribute('data-seed');
        setNote(n);
        for (const cb of seedCbs) { try { cb(n); } catch (err) { console.error(err); } }
      });
      row.addEventListener('pointerover', previewNote);
      row.addEventListener('focusin', previewNote);
      row.addEventListener('pointerleave', () => setNote(seedNow));
      row.addEventListener('focusout', () => setNote(seedNow));
      const tapEl = byId('tap');
      if (tapEl && tapEl.parentNode === inner) inner.insertBefore(row, tapEl);
      else inner.appendChild(row);
    }
    const known = list.some((r) => r.seed === current);
    row.innerHTML = '<span class="lbl">Route</span>' +
      list.map((r) => '<button class="seed' + (r.seed === current ? ' on' : '') + '" type="button" data-seed="' +
        (r.seed | 0) + '" title="' + escapeHtml(r.note || '') + '" aria-pressed="' + (r.seed === current) + '">' +
        escapeHtml(r.name) + '</button>').join('') +
      // an unlisted ?seed= is shown as it is, so you can always see which line you are on
      (known ? '' : '<span class="seed on custom" data-seed="' + (current | 0) + '" aria-current="true">Seed ' + (current | 0) + '</span>') +
      '<span class="note" id="seed-note"></span>';
    seedNow = current;
    setNote(current);
  }

  function isStartKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    const k = e.key;
    if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta' || k === 'CapsLock' || k === 'Tab' || k === 'Escape') return false;
    if (k === 'm' || k === 'M') return false;   // reserved for the mute toggle
    if (k && k.startsWith('F') && k.length > 1) return false;
    return true;
  }
  function onTitlePointer(e) {
    if (e.target && e.target.closest && e.target.closest('a, #mute, #seeds')) return;
    begin();
  }
  // ---- the code -------------------------------------------------------------------------
  // No visible box. Type the word on the title screen and letters accumulate; get it right and
  // the rune flashes. Any letter key is swallowed so it cannot also start the climb.
  let typed = '';
  function onTitleLetter(e) {
    if (!titleShown || started) return false;
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    const k = e.key;
    if (typeof k !== 'string' || k.length !== 1 || !/[a-z]/i.test(k)) return false;
    typed = (typed + k.toUpperCase()).slice(-SPIDER_CODE.length);
    if (typed === SPIDER_CODE) {
      typed = '';
      const already = spiderUnlocked();
      unlockSpider();
      codeFlash(already);
    }
    return true;                      // a letter never doubles as "press any key to begin"
  }
  let customTimer = 0;
  function codeFlash(already) {
    const sig = titleEl && titleEl.querySelector('.sigil');
    if (sig) { sig.classList.remove('code-hit'); void sig.offsetWidth; sig.classList.add('code-hit'); }
    message(already ? 'The web answers again' : 'The web answers', 2600, 'rune');
    refreshCustomBtn();
    // The reward is a choice, not a surprise — and only on the title. Typing the code and tapping
    // to begin inside the 900 ms used to drop the panel over a live climb, so the handle is kept,
    // cleared when the title goes, and the deferred open checks the title is still up.
    clearTimeout(customTimer);
    customTimer = setTimeout(() => { customTimer = 0; if (titleShown) openCustom(); }, 900);
  }

  function onTitleKey(e) {
    if (onTitleLetter(e)) { e.preventDefault(); e.stopPropagation(); return; }
    // Enter or space on a focused route pill activates the pill, not the climb.
    if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.closest && e.target.closest('#seeds')) return;
    if (!titleShown || !isStartKey(e)) return;
    e.preventDefault();
    // Registered in the capture phase on window: stopping here keeps the same keydown from reaching
    // input.js (Q / Enter would otherwise release a hand on the first frame of the climb) while
    // other capture listeners on window (the audio unlock) still run.
    e.stopPropagation();
    begin();
  }
  // B40: showTitle is no longer only the boot call — it is also the way out of a climb — so it
  // puts the shell back to the state it boots in first: no HUD, no end screen, no dead veil, and
  // no timer left over from the abandoned run waiting to raise an end screen over the title.
  function resetShell() {
    clearTimeout(endTimer);
    endTimer = 0;
    clearTimeout(msgTimer);
    clearTimeout(customTimer);
    customTimer = 0;
    msgEl.className = '';
    msgText = '';
    if (endShown) {
      endShown = false;
      endEl.classList.add('hide');
      setTimeout(() => { if (!endShown) endEl.hidden = true; }, 950);
    }
    endEl.classList.remove('dead');
    hudEl.classList.remove('dead', 'falling');
    cache.phase = null;                    // so the next climb announces itself again
    closeConfirm();
    hideHud();
  }

  function begin() {
    if (started) return;
    started = true;
    hideTitle();
    for (const cb of startCbs) {
      try { cb(); } catch (err) { console.error(err); }
    }
  }

  function showTitle(opts = {}) {
    resetShell();
    const touch = opts.touch != null ? !!opts.touch : (navigator.maxTouchPoints > 0);
    keyHints = touch ? null : { L: 'LMB', R: 'RMB' };
    pillState.L = pillState.R = '';           // force the pills to re-render with or without key hints
    setPill('L', 'free');
    setPill('R', 'free');
    const card = ensure('controls-card', 'div', titleEl.querySelector('.inner') || titleEl, 'card');
    card.innerHTML = controlsHtml(touch);
    const tap = byId('tap');
    if (tap) tap.textContent = touch ? 'Tap to begin' : 'Click or press any key to begin';
    const foot = byId('title-foot');
    if (foot) foot.innerHTML = footHtml();
    renderSeeds(opts.seeds, opts.seed);
    titleEl.hidden = false;
    titleEl.classList.remove('hide');
    dismissBoot();
    titleShown = true;
    started = false;
    syncOverlayFlag();
    titleEl.addEventListener('pointerdown', onTitlePointer);
    window.addEventListener('keydown', onTitleKey, true);
  }
  function hideTitle() {
    titleShown = false;
    clearTimeout(customTimer);        // the code's deferred panel belongs to the title it was typed on
    customTimer = 0;
    syncOverlayFlag();
    titleEl.removeEventListener('pointerdown', onTitlePointer);
    window.removeEventListener('keydown', onTitleKey, true);
    titleEl.classList.add('hide');
    setTimeout(() => { if (!titleShown) titleEl.hidden = true; }, 950);
    showHud();
  }
  function onStart(cb) {
    if (typeof cb === 'function') startCbs.push(cb);
    return hud;
  }

  // ---- end screen -----------------------------------------------------------------------------------------------
  const restartCbs = [];
  function normalizeStats(stats) {
    stats = stats || {};
    const isState = stats.hands !== undefined || stats.route !== undefined;
    const total = isState
      ? ((stats.route && stats.route.holds) || []).filter((h) => h.kind === 'rune').length
      : (stats.runesTotal != null ? stats.runesTotal : (cache.runesTotal > 0 ? cache.runesTotal : null));
    const lit = isState
      ? ((stats.runesLit && stats.runesLit.length) || 0)
      : (Array.isArray(stats.runesLit) ? stats.runesLit.length : (stats.runesLit != null ? stats.runesLit : (stats.runes != null ? stats.runes : cache.runesLit)));
    return {
      time: isState ? stats.t : (stats.time != null ? stats.time : stats.t),
      high: isState ? stats.maxHeight : (stats.high != null ? stats.high : stats.maxHeight),
      lit: Math.max(0, lit | 0),
      total: total == null ? null : (total | 0),
      complete: isState ? stats.phase === 'summit' : stats.complete !== false,
    };
  }
  function showEnd(stats) {
    const s = normalizeStats(stats);
    endShown = true;
    syncOverlayFlag();
    clearTimeout(endTimer);
    const inner = endEl.querySelector('.inner') || endEl;
    const h1 = ensure('end-title', 'h1', inner);
    h1.textContent = s.complete ? 'The ritual is complete' : 'You fell';
    if (endEl && endEl.classList) endEl.classList.toggle('dead', !s.complete);
    const grid = ensure('end-stats', 'div', inner, 'stats');
    grid.innerHTML =
      '<div class="stat"><b>' + fmtTime(s.time) + '</b><span>Time</span></div>' +
      '<div class="stat"><b>' + (+s.high || 0).toFixed(1) + '<small style="font-size:.55em;color:var(--muted)"> m</small></b><span>Highest</span></div>' +
      '<div class="stat"><b>' + s.lit + (s.total != null ? '<small style="font-size:.55em;color:var(--muted)"> / ' + s.total + '</small>' : '') + '</b><span>Runes lit</span></div>';
    const cred = ensure('end-credits', 'div', inner, 'credits');
    cred.innerHTML = '<h3>Credits</h3>' + CREDITS.map((c) =>
      '<p><b>' + escapeHtml(c.what) + ':</b> ' + escapeHtml(c.text) + ' — ' + escapeHtml(c.license) +
      ' <a href="' + c.url + '" target="_blank" rel="noopener">' + escapeHtml(c.url.replace(/^https?:\/\//, '')) + '</a></p>').join('') +
      '<p style="margin-top:6px">Design and code: Rock Climber: The Ritual, 2026. Sound effects are synthesised live in WebAudio.</p>';
    const btns = ensure('end-btns', 'div', inner, 'btns');
    let btn = byId('end-restart');
    if (!btn) {
      btn = doc.createElement('button');
      btn.id = 'end-restart';
      btn.className = 'btn';
      btn.type = 'button';
      btn.textContent = 'Climb again';
      btns.appendChild(btn);
    }
    // B40: and the other way out — no confirmation here, the climb is already over.
    let menu = byId('end-menu');
    if (!menu) {
      menu = doc.createElement('button');
      menu.id = 'end-menu';
      menu.className = 'btn ghost';
      menu.type = 'button';
      menu.textContent = 'Menu';
      btns.appendChild(menu);
    }
    menu.onclick = (e) => { e.preventDefault(); leaveClimb(); };
    btn.onclick = (e) => {
      e.preventDefault();
      if (restartCbs.length) {
        for (const cb of restartCbs) { try { cb(); } catch (err) { console.error(err); } }
      } else {
        location.reload();
      }
    };
    endEl.hidden = false;
    endEl.classList.remove('hide');
    hideHud();
  }
  function hideEnd() {
    if (hudEl && hudEl.classList) hudEl.classList.remove('dead');   // a fresh climb clears the veil
    if (endEl && endEl.classList) endEl.classList.remove('dead');
    endShown = false;
    syncOverlayFlag();
    endEl.classList.add('hide');
    setTimeout(() => { if (!endShown) endEl.hidden = true; }, 950);
    showHud();
  }
  function onRestart(cb) {
    if (typeof cb === 'function') restartCbs.push(cb);
    return hud;
  }

  // ---- mute toggle ----------------------------------------------------------------------------------------------
  const muteCbs = [];
  let muted = readMuted();
  let muteBtn = byId('mute');
  if (!muteBtn) {
    muteBtn = doc.createElement('button');
    muteBtn.id = 'mute';
    muteBtn.type = 'button';
    muteBtn.textContent = '♪';
    scope.appendChild(muteBtn);
  }
  function renderMute() {
    muteBtn.classList.toggle('muted', muted);
    muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
    muteBtn.title = muted ? 'Sound off (M)' : 'Sound on (M)';
  }
  function setMuted(b) {
    b = !!b;
    if (b === muted) { renderMute(); return; }
    muted = b;
    writeMuted(b);
    renderMute();
    if (muteCbs.length) {
      for (const cb of muteCbs) { try { cb(muted); } catch (err) { console.error(err); } }
    } else {
      // not wired by the integrator: reach the audio module through the debug handle if it exists
      const a = window.__ritual && window.__ritual.audio;
      if (a && typeof a.setMuted === 'function') a.setMuted(muted);
    }
  }
  function onMute(cb) {
    if (typeof cb === 'function') muteCbs.push(cb);
    return hud;
  }
  const onMuteClick = (e) => { e.preventDefault(); e.stopPropagation(); setMuted(!muted); };
  const onMutePointer = (e) => { e.stopPropagation(); }; // keep the title's pointerdown from starting the game
  muteBtn.addEventListener('click', onMuteClick);
  muteBtn.addEventListener('pointerdown', onMutePointer);
  const onGlobalKey = (e) => {
    if ((e.key === 'm' || e.key === 'M') && !e.metaKey && !e.ctrlKey && !e.altKey) setMuted(!muted);
  };
  window.addEventListener('keydown', onGlobalKey);
  renderMute();

  function dispose() {
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    window.removeEventListener('keydown', onGlobalKey);
    window.removeEventListener('keydown', onTitleKey, true);
    window.removeEventListener('keydown', onConfirmKey);
    if (menuBtn) menuBtn.removeEventListener('click', onMenuClick);
    if (confirmStayEl) confirmStayEl.removeEventListener('click', closeConfirm);
    if (confirmLeaveEl) confirmLeaveEl.removeEventListener('click', leaveClimb);
    if (confirmEl) confirmEl.removeEventListener('pointerdown', onConfirmBackdrop);
    clearTimeout(customTimer);
    titleEl.removeEventListener('pointerdown', onTitlePointer);
    muteBtn.removeEventListener('click', onMuteClick);
    muteBtn.removeEventListener('pointerdown', onMutePointer);
    clearTimeout(msgTimer);
    clearTimeout(endTimer);
  }

  // B47: there is no LOOK button. Looking is a drag on the screen itself, which input.js binds to
  // the canvas, so the HUD has nothing to show and nothing to say about it.
  const webBtn = doc.getElementById('web');
  let webBtnState = '';

  // ---- customisation ----------------------------------------------------------------------
  // Only exists once the code has been typed. Choosing a glove reloads the hands, which is the
  // honest way to re-skin a skinned mesh, so the caller supplies that.
  const customEl = doc.getElementById('custom');
  const customBtn = doc.getElementById('customBtn');
  const skinCbs = [];
  function markSkin() {
    const cur = spiderSkin();
    if (!customEl) return;
    customEl.querySelectorAll('.skin').forEach((b) => b.classList.toggle('on', b.dataset.skin === cur));
  }
  function openCustom() { if (customEl) { markSkin(); customEl.hidden = false; syncOverlayFlag(); } }
  function closeCustom() { if (customEl) { customEl.hidden = true; syncOverlayFlag(); } }
  // B41: the panel is how you put the glove on, so it can never be hidden behind having the glove.
  function refreshCustomBtn() { if (customBtn) customBtn.hidden = false; }
  if (customEl) {
    customEl.querySelectorAll('.skin').forEach((b) => b.addEventListener('click', () => {
      const v = b.dataset.skin;
      if (v === spiderSkin()) return;
      setSpiderSkin(v);
      markSkin();
      for (const cb of skinCbs) { try { cb(v); } catch (e) { console.error(e); } }
    }));
    const cl = doc.getElementById('customClose');
    if (cl) cl.addEventListener('click', closeCustom);
    customEl.addEventListener('pointerdown', (e) => { if (e.target === customEl) closeCustom(); });
  }
  if (customBtn) customBtn.addEventListener('click', openCustom);
  refreshCustomBtn();

  // ---- the web-zip's state, on the WEB pad and the right-hand pill ----------------------
  // Without this the ability is invisible: no cooldown, no aim state, no sign it exists.
  let webCache = '';
  let webHinted = false;                       // the one-line gesture hint, once per session
  function updateWeb(state) {
    const w = state.web;
    const el = grips.R;
    if (!w) return;
    let mark = '';
    if (w.unlocked) {
      if (w.mode === 'aiming') mark = 'aim';
      else if (w.mode === 'flying' || w.mode === 'attached') mark = 'web';
      else if (w.cd > 0) mark = 'cool';
      // 'ready' mirrors the sim's own rule, which no longer wants a free right hand: you may aim
      // with both hands on the rock and only let go when the line bites (B50). Saying 'ready'
      // only when the hand was already off was the HUD half of "the pad does nothing".
      else if (state.phase === 'climbing' || state.phase === 'falling') mark = 'ready';
    }
    const cd = w.unlocked && w.cd > 0 ? Math.min(1, w.cd / 3) : 0;
    const st = !w.unlocked ? 'off' : mark === 'cool' ? 'cool' : (mark === 'ready' || mark === 'aim' || mark === 'web') ? 'can' : 'idle';

    // The gesture is not guessable from a pad that just says WEB, so say it once, the first time
    // the pad is actually usable. Once per session, and not in the opening seconds: the climb's
    // own "light every rune" message is on screen then and would simply replace this.
    //
    // This is evaluated BEFORE the cache check on purpose. On a plain climb the pad is 'ready'
    // from the first frame and nothing about it ever changes, so the key never moves and the
    // early return below meant the hint could not fire on the one flow that needs it most.
    if (!webHinted && st === 'can' && state.phase === 'climbing' && state.t > 6) {
      webHinted = true;
      message('Hold WEB, drag to aim, let go to fire — tap it again to release the line', 4200);
    }

    // `unlocked` belongs in the key: it flips false -> true when the climb starts, and with both
    // hands still on the rock nothing else changes, so without it the pad stayed hidden until the
    // first time the right hand came off.
    const key = (w.unlocked ? 'u' : '-') + mark + '|' + Math.round(cd * 20);
    if (key === webCache) return;
    webCache = key;
    if (el) {
      el.classList.toggle('web-aim', mark === 'aim');
      el.classList.toggle('web-out', mark === 'web');
      el.classList.toggle('web-cool', mark === 'cool');
      el.classList.toggle('web-ready', mark === 'ready');
      el.style.setProperty('--cd', cd.toFixed(3));
    }

    // The same four marks and the same cooldown drain go on the PAD itself, not only on the
    // right pill: the pad is the control your thumb is on, and it must be able to tell you
    // ready / aiming / out / cooling on its own.
    if (webBtn) {
      webBtn.classList.toggle('web-aim', mark === 'aim');
      webBtn.classList.toggle('web-out', mark === 'web');
      webBtn.classList.toggle('web-cool', mark === 'cool');
      webBtn.classList.toggle('web-ready', mark === 'ready');
      webBtn.style.setProperty('--cd', cd.toFixed(3));
      if (st !== webBtnState) {
        webBtnState = st;
        webBtn.hidden = st === 'off';
        webBtn.classList.toggle('can', st === 'can');
        webBtn.classList.toggle('cool', st === 'cool');
      }
    }
  }

  const hud = {
    sticks,
    grips,
    webButton: webBtn,
    openCustom, closeCustom, refreshCustomBtn,
    onSkinChange(cb) { if (typeof cb === 'function') skinCbs.push(cb); },
    root: hudEl,
    elements: { hud: hudEl, title: titleEl, end: endEl, msg: msgEl, height: heightEl, runes: runesEl, falls: fallsEl, mute: muteBtn, menu: menuBtn, confirm: confirmEl, vignette: vigEl },
    update,
    setStick,
    message,
    showTitle,
    hideTitle,
    onStart,
    onSeed,
    showEnd,
    hideEnd,
    onRestart,
    onMenu,
    onPause,
    onMute,
    setMuted,
    get muted() { return muted; },
    dispose,
  };
  return hud;
}

export default createHud;

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
//   • hud.showEnd(stats) accepts the state object or { time, falls, runesLit, runesTotal }; the HUD
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
    topEl.innerHTML = '<div id="falls"><span>Falls</span><b>0</b></div><div id="meter"><div id="height">0.0<small>m</small></div><div id="runes"></div></div><div></div>';
    hudEl.insertBefore(topEl, msgEl);
  }
  const heightEl = ensure('height', 'div', byId('meter') || topEl);
  const runesEl = ensure('runes', 'div', byId('meter') || topEl);
  const fallsEl = ensure('falls', 'div', topEl);
  if (!fallsEl.querySelector('b')) fallsEl.innerHTML = '<span>Falls</span><b>0</b>';
  const fallsNum = fallsEl.querySelector('b');
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
    falls: null,
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
    // fonts and layout are ready only now; re-measure once the frame is painted
    requestAnimationFrame(onResize);
  }
  function hideHud() {
    cache.hudOn = false;
    hudEl.classList.remove('on');
    hudEl.setAttribute('aria-hidden', 'true');
  }

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
    el.textContent = PILL_LABEL[st] || 'Grip';
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
    } else if (next === 'caught') {
      message('The rope holds', 1900, 'gold');
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
    updateLookBtn(state);
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

    const falls = state.fallCount | 0;
    if (falls !== cache.falls) {
      cache.falls = falls;
      fallsNum.textContent = String(falls);
      fallsEl.classList.toggle('some', falls > 0);
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
        '<p class="hint">Hanging drains a hand — the arc around its stick shows how much is left. The rope saves you <b>once</b>, and not every rock holds.</p>'
      );
    }
    return (
      '<h2>How to climb</h2>' +
      '<div class="row">' +
      '<div class="hand"><b>Left hand</b><div class="keys"><kbd>Left click</kbd><span class="sep">grip / let go</span></div></div>' +
      '<div class="hand"><b>Right hand</b><div class="keys"><kbd>Right click</kbd><span class="sep">grip / let go</span></div></div>' +
      '<p class="hint"><em>Move the mouse</em> and the hand that is hanging free follows it. Let a hand go, point where you want it, click again to take the rock.</p>' +
      '</div>' +
      '<p class="hint">Hanging drains a hand — rest on the <i>glowing runes</i>. The rope saves you <b>once</b>. Not every rock holds. <kbd>M</kbd> mutes.</p>'
    );
  }
  function footHtml() {
    return CREDITS.slice(0, 3).map((c) => escapeHtml(c.text) + ' (' + escapeHtml(c.license.replace('Licensed under Creative Commons: By Attribution 4.0', 'CC BY 4.0')) + ')').join(' · ');
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
    if (e.target && e.target.closest && e.target.closest('a, #mute')) return;
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
  function codeFlash(already) {
    const sig = titleEl && titleEl.querySelector('.sigil');
    if (sig) { sig.classList.remove('code-hit'); void sig.offsetWidth; sig.classList.add('code-hit'); }
    message(already ? 'The web answers again' : 'The web answers', 2600, 'rune');
    refreshCustomBtn();
    setTimeout(openCustom, 900);        // the reward is a choice, not a surprise
  }

  function onTitleKey(e) {
    if (onTitleLetter(e)) { e.preventDefault(); e.stopPropagation(); return; }
    if (!titleShown || !isStartKey(e)) return;
    e.preventDefault();
    // Registered in the capture phase on window: stopping here keeps the same keydown from reaching
    // input.js (Q / Enter would otherwise release a hand on the first frame of the climb) while
    // other capture listeners on window (the audio unlock) still run.
    e.stopPropagation();
    begin();
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
    titleEl.hidden = false;
    titleEl.classList.remove('hide');
    dismissBoot();
    titleShown = true;
    started = false;
    titleEl.addEventListener('pointerdown', onTitlePointer);
    window.addEventListener('keydown', onTitleKey, true);
  }
  function hideTitle() {
    titleShown = false;
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
      falls: isState ? stats.fallCount : (stats.falls != null ? stats.falls : stats.fallCount),
      lit: Math.max(0, lit | 0),
      total: total == null ? null : (total | 0),
      complete: isState ? stats.phase === 'summit' : stats.complete !== false,
    };
  }
  function showEnd(stats) {
    const s = normalizeStats(stats);
    endShown = true;
    clearTimeout(endTimer);
    const inner = endEl.querySelector('.inner') || endEl;
    const h1 = ensure('end-title', 'h1', inner);
    h1.textContent = s.complete ? 'The ritual is complete' : 'You fell';
    if (endEl && endEl.classList) endEl.classList.toggle('dead', !s.complete);
    const grid = ensure('end-stats', 'div', inner, 'stats');
    grid.innerHTML =
      '<div class="stat"><b>' + fmtTime(s.time) + '</b><span>Time</span></div>' +
      '<div class="stat"><b>' + (s.falls | 0) + '</b><span>Falls</span></div>' +
      '<div class="stat"><b>' + s.lit + (s.total != null ? '<small style="font-size:.55em;color:var(--muted)"> / ' + s.total + '</small>' : '') + '</b><span>Runes lit</span></div>';
    const cred = ensure('end-credits', 'div', inner, 'credits');
    cred.innerHTML = '<h3>Credits</h3>' + CREDITS.map((c) =>
      '<p><b>' + escapeHtml(c.what) + ':</b> ' + escapeHtml(c.text) + ' — ' + escapeHtml(c.license) +
      ' <a href="' + c.url + '" target="_blank" rel="noopener">' + escapeHtml(c.url.replace(/^https?:\/\//, '')) + '</a></p>').join('') +
      '<p style="margin-top:6px">Design and code: Rock Climber: The Ritual, 2026. Sound effects are synthesised live in WebAudio.</p>';
    let btn = byId('end-restart');
    if (!btn) {
      btn = doc.createElement('button');
      btn.id = 'end-restart';
      btn.className = 'btn';
      btn.type = 'button';
      btn.textContent = 'Climb again';
      inner.appendChild(btn);
    }
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
    titleEl.removeEventListener('pointerdown', onTitlePointer);
    muteBtn.removeEventListener('click', onMuteClick);
    muteBtn.removeEventListener('pointerdown', onMutePointer);
    clearTimeout(msgTimer);
    clearTimeout(endTimer);
  }

  // LOOK: input.js binds hold-to-look to this button; it only lights up when a hand is free.
  const lookBtn = doc.getElementById('look');
  const webBtn = doc.getElementById('web');
  let canLookNow = null;
  let webBtnState = '';
  function updateLookBtn(state) {
    if (!lookBtn) return;
    const L = state.hands && state.hands.L, R = state.hands && state.hands.R;
    const can = !!L && !!R && (L.gripping !== R.gripping)
      && (state.phase === 'climbing' || state.phase === 'caught');
    if (can !== canLookNow) { canLookNow = can; lookBtn.classList.toggle('can', can); }
  }

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
  function openCustom() { if (customEl) { markSkin(); customEl.hidden = false; } }
  function closeCustom() { if (customEl) customEl.hidden = true; }
  function refreshCustomBtn() { if (customBtn) customBtn.hidden = !spiderUnlocked(); }
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
  // Pressing LOOK with both hands on the rock does nothing by design — you need a free arm to
  // turn — so say that rather than leaving the button feeling broken.
  if (lookBtn) lookBtn.addEventListener('pointerdown', () => {
    if (!canLookNow) message('Let a hand go to look around', 1800);
  });
  refreshCustomBtn();

  // ---- the web-zip's state, on the right-hand pill --------------------------------------
  // Without this the ability is invisible: no cooldown, no aim state, no sign it exists.
  let webCache = '';
  function updateWeb(state) {
    const w = state.web;
    const el = grips.R;
    if (!el || !w) return;
    let mark = '';
    if (w.unlocked) {
      if (w.mode === 'aiming') mark = 'aim';
      else if (w.mode === 'flying' || w.mode === 'attached') mark = 'web';
      else if (w.cd > 0) mark = 'cool';
      else if (!state.hands.R.gripping) mark = 'ready';
    }
    const cd = w.unlocked && w.cd > 0 ? Math.min(1, w.cd / 3) : 0;
    const key = mark + '|' + Math.round(cd * 20);
    if (key === webCache) return;
    webCache = key;
    el.classList.toggle('web-aim', mark === 'aim');
    el.classList.toggle('web-out', mark === 'web');
    el.classList.toggle('web-cool', mark === 'cool');
    el.classList.toggle('web-ready', mark === 'ready');
    el.style.setProperty('--cd', cd.toFixed(3));

    // the touch pad only exists once unlocked, and dims while the shot is cooling
    if (webBtn) {
      const st = !w.unlocked ? 'off' : mark === 'cool' ? 'cool' : (mark === 'ready' || mark === 'aim' || mark === 'web') ? 'can' : 'idle';
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
    lookButton: lookBtn,
    webButton: webBtn,
    openCustom, closeCustom, refreshCustomBtn,
    onSkinChange(cb) { if (typeof cb === 'function') skinCbs.push(cb); },
    root: hudEl,
    elements: { hud: hudEl, title: titleEl, end: endEl, msg: msgEl, height: heightEl, runes: runesEl, falls: fallsEl, mute: muteBtn, vignette: vigEl },
    update,
    setStick,
    message,
    showTitle,
    hideTitle,
    onStart,
    showEnd,
    hideEnd,
    onRestart,
    onMute,
    setMuted,
    get muted() { return muted; },
    dispose,
  };
  return hud;
}

export default createHud;

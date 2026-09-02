# CONTRACTS — Rock Climber: The Ritual

Every build agent reads this file first. It is the only shared truth between domains.
Read also `docs/superpowers/specs/2026-09-01-rock-climber-ritual-design.md` (the design and
the wizard decisions table at its end). Where the two disagree, this file wins.

It was frozen for the orchestrated run and then drifted, because the run shipped things the
contract had not imagined: the web-zip, the spider hand, the route picker, the decoy dust. It
was brought back in line with the code on 2026-09-02 (B37). It is maintained now, not frozen:
change the code and change this in the same commit, or the drift starts again.

## Units, axes, coordinate system
- Meters. Wall plane at z = 0, wall normal +z (toward the climber and camera). +y is up. +x is the climber's right.
- The simulation is 2-D in (x, y) on the wall plane. Rendering adds depth with `world.wallZ(x, y)`,
  a deterministic noise displacement, |z| ≤ 0.35. Body sits at z = wallZ(body) + 0.55; a hand touching the
  wall sits at z = wallZ(hand) + 0.02; camera at body + (0, 0.30, 0.62) before rig effects.
- Route runs from y ≈ 1.2 (start holds) to y ≈ 40 (summit altar). Cliff is ~9 m wide (x in [-4.5, 4.5]).

## Module ownership (one owner per file; nobody else edits these)
| Domain | Files |
|---|---|
| sim-input | `src/sim.js`, `src/route.js`, `src/input.js`, `test/*.test.js` |
| world-light | `src/world.js`, `src/post.js`, `src/env.js`, `src/shaders/*`, `src/webFx.js` |
| arms-camera | `src/arms.js`, `src/camera.js`, `src/spiderHand.js`, `src/webLine.js` |
| hud-audio | `index.html`, `src/hud.js`, `src/audio.js`, `assets/audio/*`, `manifest.webmanifest` |
| integrator | `src/main.js`, `CONTRACTS.md`, `README.md`, `docs/**`, deploy config, `review/**` |

`src/env.js` is shared plumbing under world-light: seeded RNG, easing, canvas textures and the
`createParticles` pool the embers and the decoy dust both run on. `mockups/**` belongs to whoever
is asking Maor a question; nothing in the game imports it.

`index.html` holds the importmap (`"three": "./vendor/three/three.module.js"`, `"three/addons/": "./vendor/three/addons/"`),
a full-screen `<canvas id="gl">`, the HUD DOM, and `<script type="module" src="./src/main.js">`. hud-audio owns it but must keep
those four things present and the ids listed in the HUD section stable.

## Shared state (sim.js writes; everyone else reads only)
```js
state = {
  t,                                   // seconds since start
  phase: 'title' | 'climbing' | 'grounded' | 'swinging' | 'falling' | 'fallen' | 'summit',
                                       // 'grounded': standing at the foot of the route, nothing held
                                       // 'swinging': hanging on the web line
                                       // 'fallen':   on the ground after a fall; the climb is over
  body:  { x, y, vx, vy },             // shoulder center
  hands: { L: Hand, R: Hand },
  height, maxHeight,                   // height = body.y
  runesLit: number[],                  // hold ids of lit runes, in order
  checkpoint: number | null,           // last lit rune hold id
  night: 0..1,                         // progression of dusk→night, derived from height/top
  web: Web,                            // the web-zip; `unlocked` is false until main.js reads the egg
  route: { holds: Hold[], fakes: Hold[], top, seed },
  events: Event[],                     // appended by step(); consumers call drainEvents()
}
Hand  = { side:'L'|'R', x, y, vx, vy, tx, ty, gripping, holdId|null, armed, stamina 0..1, tremble 0..1, curl 0..1, hover 0..1,
          nearId, nearDist }           // nearest hold; read-only convenience for the HUD
Hold  = { id, x, y, size (0.10..0.24 radius), kind: 'hold'|'rune'|'summit', lit:boolean, angle }
Fake  = a Hold with ids from 10000 up and `broken` set once it has given way. Never on the line, never the only way up.
Web   = { mode: 'idle'|'aiming'|'flying'|'attached', ax, ay,   // anchor the line bit
          tipX, tipY, len, cd, aimX, aimY, unlocked }          // cd = cooldown left, 3 s after a shot
Event = { type, hand?: 'L'|'R', holdId?: number, ...extras }
  climbing: 'start' | 'grab' | 'release' | 'miss' | 'arm' | 'slip' | 'rune' | 'summit'
  the drop: 'fall' | 'impact' | 'fallen'      — no 'catch': nothing catches a fall (B43)
  the rock: 'crumble' (+holdId of the decoy)
  the zip:  'aim' | 'webshot' | 'webhit' (+yank) | 'webmiss' | 'webcut'
Anything reading events must ignore types it does not know: the list grows.
Input = { L:{x,y,active}, R:{x,y,active}, tapL:boolean, tapR:boolean,
          look:{ x, y, active },                           // look: hold-to-look; sim ignores it, the camera rig consumes it
          holdL:boolean, holdR:boolean }                   // grip currently HELD; the spider hand aims on a held right grip (true for one frame)
  // stick `active`: something is on that stick this frame — a finger, the mouse driving that hand, a movement key, or a
  // recenter (Escape / a grip key, for one read). It is how the sim tells a stick nobody is touching from one reading
  // zero (B45); an Input without the flag is read the old way, where only a non-zero vector steers.
```
Constants live in `sim.js` as `CFG`: REACH 0.72, SNAP 0.16, SHOULDER_DX 0.19, SHOULDER_DY 0.08, HANG_TWO 0.42, HANG_ONE 0.50,
GRACE 0.25, FLOOR 0.75, FALL_TERMINAL 26, drain two-hand 0.05/s, one-hand 0.20/s, refill free 0.18/s, rune refill 0.50/s, forced release at 0.

Behavior (kinematic with physical feel): free hands spring-damp toward `shoulder + stick × REACH`, and letting go of the stick
leaves the hand there — the target is kept as an offset from the shoulder, so a parked hand rides along when the body moves, and it
holds until the stick is pushed again or the hand takes rock (B45). A hand that has not been steered since it last held rock hangs at
a rest offset instead: at the start of a climb, and after every release, since taking a hold clears where the hand was parked.
Body spring-damps to the mean of gripped holds minus HANG, sways toward the loaded arm on one-hand hangs, releases
of both hands begin a fall that nothing stops (B43): a quarter-second GRACE window in which a hand can still find rock, then the
whole cliff at terminal velocity to `phase 'fallen'` and the death screen. Letting go with your feet still on the ground
(`_fall.from ≤ FLOOR + HANG_TWO`) is not a fall: you stay standing, in `phase 'grounded'`, and can take the rock again. Stamina drains and
refills as above, GRIP is a tap toggle with arming (tap away from a hold → armed → grabs the next hold within SNAP), rune holds are
rest holds and checkpoints, grabbing the summit hold → `phase 'summit'`.

## Interfaces
```js
// sim-input
export const CFG;                                    // sim.js
export function generateRoute(seed = 7) → route      // route.js — deterministic, every hold reachable (≤ 0.9·REACH from the projected shoulder), rune every ~8 m, last hold kind 'summit'
export function createClimber(route) → state         // sim.js — phase 'title'; both hands on the two start holds
export function startClimb(state)                    // → phase 'climbing', event 'start'
export function step(state, input, dt)               // mutates; dt clamped to ≤ 1/20 inside
export function drainEvents(state) → Event[]         // returns and clears
export function shoulder(state, side) → { x, y }
export function aimPoint(state) → { x, y } | null     // where the web shot would land; the camera rig and the HUD reticle both read it
export function cutWeb(state)                        // drop the line from outside the sim
export function generateRoute(seed) also returns `fakes`; SEEDS / DEFAULT_SEED / normalizeSeed(v) back the route picker
export function createInput({ hud, keyboard = true, win, now, mouse, getHands }) → { read(): Input, dispose() }   // input.js — touch/mouse on hud.sticks + hud.grips + hud.lookButton + hud.webButton (pointer events), keyboard WASD+Q / arrows+Enter or Slash; sticks: position mapping, zero and `active` false the moment the finger lifts; keyboard: integrating virtual stick that holds its value, `active` only while a key is down; taps are edge-triggered. `win` and `now` are injected so the tests can drive it headless

// world-light
export async function createWorld({ renderer, scene, route, tier }) → world             // world.js — loads textures + HDRI itself (paths below)
world.wallZ(x, y) → number; world.holdZ(hold) → number
world.update(dt, state, camera, events)               // holds glow when hovered/lit, decoys fall, particles, time-of-day from state.night. `events` fires the decoy dust on 'crumble', so it lands the frame the hand comes off
world.setTier(tier)
export function createPost({ renderer, scene, camera, tier }) → post                      // post.js — EffectComposer: RenderPass → UnrealBloom → vignette/grain ShaderPass → OutputPass
post.render(dt); post.resize(w, h); post.setNight(t01); post.setTier(tier)

// arms-camera
export async function createArms({ scene, tier, shoulder, holdZ }) → arms                // arms.js — loads assets/models/hands/realistic_hand.glb (left = mirrored), builds forearm + sleeve per side, 2-bone IK from shoulder, finger curl from Hand.curl (use the model's 'Grab' clip or bone rotation), tremble from Hand.tremble. `shoulder` and `holdZ` are passed in so arms.js imports neither the sim nor the world
arms.update(dt, state, wallZ, camera)
export function createCameraRig(camera) → rig                                           // camera.js — follows body, breathing, roll toward loaded arm, look-up bias toward the hands, fall/catch shake, fov kick on grab
rig.update(dt, state, wallZ, events, lookIn, aim)     // lookIn = Input.look, aim = aimPoint(state) while aiming (else null): aiming pulls the eye back and turns the view to the anchor
rig.setPortrait(isPortrait); rig.kick(...)
export function createWebLine({ variant, segments }) → line                              // webLine.js — the line as real geometry, lashing as it flies
export function applySpiderSkin(root, { variant }) ; spiderUnlocked() / unlockSpider() / spiderSkin() / setSpiderSkin(v)   // spiderHand.js — the egg, remembered per device

// hud-audio
export function createHud(root) → hud                                                    // hud.js — owns all DOM under #hud, #title, #end and #custom
hud.sticks = { L: HTMLElement, R: HTMLElement }; hud.grips = { L: HTMLElement, R: HTMLElement }
hud.lookButton, hud.webButton                         // input.js binds pointer events to all four; they are drag pads, not press-and-hold buttons
hud.update(state, events)                             // stamina arcs, knob positions come from input via hud.setStick(side, x, y), grip pill state, height meter, rune progress, fall count, the web-zip's own state on the right pill
hud.setStick(side, x, y)                              // called by input.js each frame with the stick vector
hud.message(text, ms = 2200); hud.showTitle({ touch, seeds, seed }); hud.hideTitle(); hud.onStart(cb); hud.onSeed(cb); hud.showEnd(stats); hud.onRestart(cb)
hud.openCustom() / closeCustom() / refreshCustomBtn() / onSkinChange(cb)                 // the hand panel behind the ✦ button
export function createAudio() → audio                                                   // audio.js — WebAudio; call audio.unlock() on first user gesture
audio.handle(events, state, dt)                       // wind bed follows height/night, cues per event, heartbeat when any stamina < 0.25
audio.setMusic(url); audio.setMuted(b); audio.muted
```
Required DOM ids in `index.html`: `#gl` (canvas), `#hud`, `#title`, `#end`, `#stick-l`, `#stick-r`, `#grip-l`, `#grip-r`,
`#ctl-l`, `#ctl-r`, `#look`, `#web`, `#height`, `#runes`, `#msg`, `#falls`, `#mute`, `#vig`, `#seeds`, `#custom`, `#customBtn`, `#boot`.

**Control layout invariant (B34).** `#look` and `#web` are children of `#ctl-l` and `#ctl-r`, the first item in each
column: pad, then GRIP pill, then stick. They must stay in the flow — do not give them `position: fixed` and a
z-index above the HUD again. They used to float over the middle of the screen and landed inside the bottom of the
stick rings, where they took a thumb sliding down a stick. The cluster is anchored at its bottom edge, so hiding
`#web` while the egg is locked leaves GRIP and the stick exactly where they are.

## main.js loop (integrator)
```
input.read → sim.step (fixed 120 Hz accumulator) → events = drainEvents
           → world.update(dt, state, camera, events)
             arms.update(dt, state, wallZ, camera)
             rig.update(dt, state, wallZ, events, lookIn, aim)
             hud.update(state, events)
             audio.handle(events, state, dt)
           → post.render(dt)
```
The one array of events from `drainEvents` is passed to every consumer in the same frame; nobody re-reads the sim to
find out what happened. Render at display rate.
`window.__ritual = { state, world, arms, rig, post, hud, audio, input, renderer, scene, camera, tier, perf, errors, debug, seed, sim, ready }`
for tests and evidence capture — `state`, `world`, `arms`, `rig` and `post` are getters, because a restart or a re-skin
replaces them. `debug` offers `start() / restart() / teleport(y) / tap(side) / hold(side, bool) / fall() / autopilot(b)`,
and the URL accepts `?seed= ?auto ?tier=phone ?fps=1`.

## Assets (already in the repo; paths are relative to project root)
- Wall PBR: `assets/textures/rock_face_03/{Diffuse_2k,nor_gl_2k,Diffuse_1k,nor_gl_1k,Rough_1k,AO_1k,Displacement_1k}.jpg`
- Hold PBR: `assets/textures/rock_boulder_dry/{Diffuse_1k,nor_gl_1k,Rough_1k,AO_1k}.jpg`
- Sky HDRI: `assets/hdri/kloppenheim_06_puresky_{2k,1k}.hdr`
- Hands: `assets/models/hands/realistic_hand.glb` (CC-BY 3.0, J-Toastie; credit in `assets/models/hands/LICENSE.md`; the credits screen must show it)
- Music: hud-audio finds one CC0 / CC-BY / public-domain track (dark ambient, ritual mood), saves it as `assets/audio/theme.mp3` (≤ 6 MB) with its credit in `assets/CREDITS.md`, and plays it via audio.setMusic after unlock. If no compliant track is found, ship without music and say so.
- three.js: `vendor/three/**` (0.185). Do not add dependencies or CDN scripts. Google Fonts (Cinzel, Inter) allowed in index.html.

## Quality tiers
```js
tier = { name, pixelRatio, shadowMapSize, bloomScale, textureRes, antialias }
phone   = { 'phone',   min(dpr, 2), 1024, 0.5, '2k color+normal, 1k rest', true }   // iPhone 14/15 class; target ≥ 30 fps at 390×844 @2
desktop = { 'desktop', min(dpr, 2), 2048, 1.0, '2k', true }
```
`main.js` picks the tier (`navigator.maxTouchPoints > 1 && /iPhone|iPad|Android/i.test(ua)` → phone) and steps pixelRatio down by 0.25 when the 2-second average frame rate drops under 24.

## Conventions
- Plain ES modules, no build step, no TypeScript, no framework. Comments explain intent, not syntax.
- Colors: rock mid #7a5238, sky dusk #5b3d6e → night #0a0c18, rune/accent #7fe0ff, HUD gold #d99a5b, text #f1e6d8, fonts Cinzel (title) + Inter (UI).
- Portrait first; landscape must remain playable. Safe-area insets respected. No text selection, no tap highlight, no double-tap zoom, `touch-action: none` on the canvas and sticks.
- Tests: `node --test test/` must pass for sim-input before the integrator merges. Rendering domains verify with the dev server: `python3 tools/devserver.py 8787` (already running in the session) → http://localhost:8787/.
- Evidence capture for critics: screenshots at three heights (start, ~20 m, summit approach) in a 390×844 portrait viewport at 2× and one desktop 1440×900 frame, plus an fps read from `window.__ritual` over 10 s, plus console-error count. Prefer the chrome-devtools MCP (its own Chrome) or a background Browser-pane tab; never front or navigate the user's visible tab.
- Never touch files you do not own; report contract problems to the integrator instead of working around them.

# CONTRACTS — Rock Climber: The Ritual (frozen for the orchestrated run)

Every build agent reads this file first. It is the only shared truth between domains.
Read also `docs/superpowers/specs/2026-09-01-rock-climber-ritual-design.md` (the design and
the wizard decisions table at its end). Where the two disagree, this file wins.

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
| world-light | `src/world.js`, `src/post.js`, `src/env.js`, `src/shaders/*` |
| arms-camera | `src/arms.js`, `src/camera.js` |
| hud-audio | `index.html`, `src/hud.js`, `src/audio.js`, `assets/audio/*`, `manifest.webmanifest` |
| integrator | `src/main.js`, `CONTRACTS.md`, `README.md`, deploy config, `review/**` |

`index.html` holds the importmap (`"three": "./vendor/three/three.module.js"`, `"three/addons/": "./vendor/three/addons/"`),
a full-screen `<canvas id="gl">`, the HUD DOM, and `<script type="module" src="./src/main.js">`. hud-audio owns it but must keep
those four things present and the ids listed in the HUD section stable.

## Shared state (sim.js writes; everyone else reads only)
```js
state = {
  t,                                   // seconds since start
  phase: 'title' | 'climbing' | 'falling' | 'caught' | 'summit',
  body:  { x, y, vx, vy },             // shoulder center
  hands: { L: Hand, R: Hand },
  ropeAnchor: { x, y },                // summit anchor the rope hangs from
  fallCount, height, maxHeight,        // height = body.y
  runesLit: number[],                  // hold ids of lit runes, in order
  checkpoint: number | null,           // last lit rune hold id
  night: 0..1,                         // progression of dusk→night, derived from height/top
  route: { holds: Hold[], top, seed },
  events: Event[],                     // appended by step(); consumers call drainEvents()
}
Hand  = { side:'L'|'R', x, y, vx, vy, tx, ty, gripping, holdId|null, armed, stamina 0..1, tremble 0..1, curl 0..1, hover 0..1 }
Hold  = { id, x, y, size (0.10..0.24 radius), kind: 'hold'|'rune'|'summit', lit:boolean, angle }
Event = { type: 'start'|'grab'|'release'|'miss'|'arm'|'slip'|'rune'|'fall'|'catch'|'summit', hand?: 'L'|'R', holdId?: number }
Input = { L:{x,y}, R:{x,y}, tapL:boolean, tapR:boolean }   // sticks in the unit disc; taps edge-triggered (true for one frame)
```
Constants live in `sim.js` as `CFG`: REACH 0.72, SNAP 0.16, SHOULDER_DX 0.19, SHOULDER_DY 0.08, HANG_TWO 0.42, HANG_ONE 0.50,
ROPE_SLACK 1.3, GRACE 0.25, drain two-hand 0.05/s, one-hand 0.20/s, refill free 0.18/s, rune refill 0.50/s, forced release at 0.

Behavior (kinematic with physical feel): free hands spring-damp toward `shoulder + stick × REACH` (stick released → drift back to
a rest offset), body spring-damps to the mean of gripped holds minus HANG, sways toward the loaded arm on one-hand hangs, releases
of both hands drop the body by ROPE_SLACK then the rope catches (`phase 'caught'`, event 'catch', fallCount++), stamina drains and
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
export function createInput({ hud, keyboard = true }) → { read(): Input, dispose() }   // input.js — touch/mouse on hud.sticks + hud.grips (pointer events), keyboard WASD+Q / arrows+Enter or Slash; sticks: position mapping; keyboard: integrating virtual stick that holds its value; taps are edge-triggered

// world-light
export async function createWorld({ renderer, scene, route, tier }) → world             // world.js — loads textures + HDRI itself (paths below)
world.wallZ(x, y) → number
world.update(dt, state, camera)                       // holds glow when hovered/lit, rope mesh follows body→anchor, particles, time-of-day from state.night
world.setTier(tier)
export function createPost({ renderer, scene, camera, tier }) → post                      // post.js — EffectComposer: RenderPass → UnrealBloom → vignette/grain ShaderPass → OutputPass
post.render(dt); post.resize(w, h); post.setNight(t01)

// arms-camera
export async function createArms({ scene, tier }) → arms                                // arms.js — loads assets/models/hands/realistic_hand.glb (left = mirrored), builds forearm + sleeve per side, 2-bone IK from shoulder, finger curl from Hand.curl (use the model's 'Grab' clip or bone rotation), tremble from Hand.tremble
arms.update(dt, state, wallZ, camera)
export function createCameraRig(camera) → rig                                           // camera.js — follows body, breathing, roll toward loaded arm, look-up bias toward the hands, fall/catch shake, fov kick on grab
rig.update(dt, state, wallZ); rig.setPortrait(isPortrait)

// hud-audio
export function createHud(root) → hud                                                    // hud.js — owns all DOM under #hud and #title
hud.sticks = { L: HTMLElement, R: HTMLElement }; hud.grips = { L: HTMLElement, R: HTMLElement }   // input.js binds pointer events to these
hud.update(state)                                     // stamina arcs, knob positions come from input via hud.setStick(side, x, y), grip pill state, height meter, rune progress, fall count
hud.setStick(side, x, y)                              // called by input.js each frame with the stick vector
hud.message(text, ms = 2200); hud.showTitle({ touch:boolean }); hud.hideTitle(); hud.onStart(cb); hud.showEnd(stats)
export function createAudio() → audio                                                   // audio.js — WebAudio; call audio.unlock() on first user gesture
audio.handle(events, state, dt)                       // wind bed follows height/night, cues per event, heartbeat when any stamina < 0.25
audio.setMusic(url); audio.setMuted(b); audio.muted
```
Required DOM ids in `index.html`: `#gl` (canvas), `#hud`, `#title`, `#stick-l`, `#stick-r`, `#grip-l`, `#grip-r`, `#height`, `#runes`, `#msg`, `#end`.

## main.js loop (integrator)
```
input.read → sim.step → events = drainEvents → world.update, arms.update, rig.update, hud.update, audio.handle → post.render
```
Fixed-step accumulator at 120 Hz for sim; render at display rate. `window.__ritual = { state, world, arms, hud, audio, sim }` for tests and evidence capture.

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

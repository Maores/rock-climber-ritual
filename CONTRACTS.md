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
          nearId, nearDist }             // nearest hold; read-only convenience for the HUD
  // `armed` is a constant false since B51 — nothing arms any more, a hovering hand grabs. It is
  // still on the hand because world.js reads it for the hover ring; never set it.
  // `nearId`/`nearDist`/`hover` are the CUE: the rock the hand is over, even one it may not take
  // (the hold it just released), so the glow is always on the rock under the hand.
Hold  = { id, x, y, size (0.10..0.24 radius), kind: 'hold'|'rune'|'summit', lit:boolean, angle }
Fake  = a Hold with ids from 10000 up and `broken` set once it has given way. Never on the line, never the only way up.
Web   = { mode: 'idle'|'aiming'|'flying'|'attached', ax, ay,   // anchor the line bit
          tipX, tipY, len, cd, aimX, aimY, unlocked,           // cd = cooldown left, 3 s after a shot
          grounded, walled }                                   // while swinging: the floor / the edge of the cliff is
                                                               // holding the body off the circle this frame
Event = { type, hand?: 'L'|'R', holdId?: number, ...extras }
  climbing: 'start' | 'grab' | 'release' | 'miss' | 'slip' | 'rune' | 'summit'
            // no 'arm' since B51; 'miss' is now a hand that came off a hold before the fingers closed, and its
            // `holdId` is whatever the fingers were on — a decoy's id (>= 10000) as readily as a real hold's, so
            // anything that looks the id up must tolerate a miss. One hand reports at most one every MISS_COOLDOWN
  the drop: 'fall' | 'impact' | 'fallen'      — no 'catch': nothing catches a fall (B43)
  the rock: 'crumble' (+holdId of the decoy)
  the zip:  'aim' | 'webshot' | 'webhit' (+yank) | 'webmiss' | 'webcut'
            // 'aim' the moment aiming starts (the pad: first frame; the right grip: after WEB_AIM_HOLD); 'webshot' on the
            // release that looses it; 'webmiss' if the anchor is inside WEB_MIN (0.35 s cooldown, no line); 'webhit' when it
            // bites — BOTH hands let go then, and only then; 'webcut' on the tap that lets go, and on a hold caught mid-swing.
Anything reading events must ignore types it does not know: the list grows.
Input = { L:{x,y,active}, R:{x,y,active},
          look:{ x, y, active, homing, down },             // the head, in DEGREES of yaw and pitch (B47), already clamped to how far you can
                                                           // really see: both hands on the rock is the neck alone (60 either way, 40 up, 55
                                                           // down), one hand free is 180 across following the free arm (35 in / 145 out, 62 up,
                                                           // 85 down), no hands is the same 180 symmetric. Those numbers live in input.js, next
                                                           // to the accumulator that clamps itself to them. Absolute degrees, not a fraction of
                                                           // the arc, so a hand letting go widens what you can reach without moving the view.
                                                           // It is not a stick: a drag on the play surface adds to it and lifting the finger
                                                           // changes nothing, so the view stays where you leave it. input.js eases it to 0 over
                                                           // ~0.4 s when a hand takes the rock or the last hand leaves it (it watches getHands),
                                                           // and says so with `homing` so the rig follows instead of easing a second time.
                                                           // `active` = a look gesture is in progress; it does NOT gate whether looking is
                                                           // allowed. `down` is the live arc's downward limit, for the vertigo lens.
                                                           // The sim ignores all of it; the camera rig consumes it
          holdR:boolean,                                   // the WEB pad (or the right mouse button) is held; the web-zip aims on it
          web:{ x, y, active, tap, cancel } }              // the web-zip gesture — see below
  // The two sticks are the whole climb (B51). `tapL`/`tapR` and `holdL` are GONE with the GRIP
  // buttons: nothing taps, so nothing produces them and the sim reads neither.
  // stick `active`: something is on that stick this frame — a finger, the mouse driving that hand, or a movement key.
  // It is how the sim tells a stick nobody is touching from one reading zero (B45); an Input without the flag is read
  // the old way, where only a non-zero vector steers. There is no one-read "recenter" pulse any more (B51): the only
  // things that move a parked hand are a steer, taking rock, and the reach clamp.
  //
  // `web` (B50) is the whole web-zip gesture, from the WEB pad or the desktop right button:
  //   x, y   — the aim vector. Its OWN vector, never `R.x/R.y`: the sim reads `R` to steer the right HAND, so while the
  //            aim shared that field the right stick was dead for as long as a thumb was on the pad, the hand could never
  //            park, and it did not in fact point at the anchor (`_stick` is a shoulder-relative offset that rotates with
  //            the body: measured 38–60° off through a swing). The pad aims; the stick still moves the hand — and under
  //            B51 that stick is also what lets the right hand go, so the two must stay apart.
  //   active — the press has COMMITTED to being an aim: HELD past 250 ms, or DRAGGED past 0.15 of the pad radius. Only a
  //            committed press is holdR, so a brush of the pad neither aims nor fires. WEB_AIM_HOLD still governs the
  //            desktop right button; the pad disambiguates by commitment instead.
  //   tap    — press and lift inside 250 ms with NO drag. This is the only thing that lets go of an ATTACHED line.
  //   cancel — the browser took the pointer mid-aim. Not a release: the sim puts the aim away and charges no cooldown.
  // `tap` and `cancel` are EDGES that the SIM consumes on first read. One input read feeds every fixed sub-step of a
  // rendered frame, so a flag left standing is seen again on the next sub-step; a tap that outlived the bite cut the line
  // one step after it attached. Consuming them in the sim, not the integrator, is deliberate: it must not depend on
  // main.js's tap plumbing, which went away with the GRIP buttons (B51).
  // While the pad is committed it IS holdR. `web` is handed out twice — as `Input.web` and as `Input.R.web`, the SAME
  // object — because an integrator that forwards the Input field by field drops new top-level fields on the floor, which
  // is exactly how B48 happened. `R` is the right hand's own control group and is forwarded by reference, so it arrives.
```
Constants live in `sim.js` as `CFG`: REACH 0.72, SNAP 0.16, SHOULDER_DX 0.19, SHOULDER_DY 0.08, HANG_TWO 0.42, HANG_ONE 0.50,
GRACE 0.25, FLOOR 0.75, FALL_TERMINAL 26, drain per gripping hand 0.022/s with two hands on, 0.085/s with one, both times the hold's own multiplier (jug 0.65 to crimp 1.85), refill free 0.30/s, rune refill 0.50/s, forced release at 0,
HOVER_GRAB_DWELL 0.12, HOVER_HYST 0.012, MISS_COOLDOWN 0.30, RELEASE_DEADZONE 0.35, RELEASE_CONFIRM 0.016, SLIP_REST 0.15,
REGRIP_LOCK 0.14, SKIP_CLEAR 0.04 (those eight are B51's; the first five and SLIP_REST are feel, and the owner may retune them).

Behavior (kinematic with physical feel): free hands spring-damp toward `shoulder + stick × REACH`, and letting go of the stick
leaves the hand there — the target is kept as an offset from the shoulder, so a parked hand rides along when the body moves, and it
holds until the stick is pushed again or the hand takes rock (B45). A hand that has not been steered since it last held rock hangs at
a rest offset instead: at the start of a climb, and after every release, since taking a hold clears where the hand was parked.
Body spring-damps to the mean of gripped holds minus HANG, sways toward the loaded arm on one-hand hangs, releases
of both hands begin a fall that nothing stops (B43): a quarter-second GRACE window in which a hand can still find rock, then the
whole cliff at terminal velocity to `phase 'fallen'` and the death screen. Letting go with your feet still on the ground
(`_fall.from ≤ FLOOR + HANG_TWO`) is not a fall: you stay standing, in `phase 'grounded'`, and can take the rock again. Stamina drains and
refills as above, rune holds are rest holds and checkpoints, grabbing the summit hold → `phase 'summit'`.

**There are no GRIP buttons (B51).** The two sticks are the whole climb.
- **Grabbing is automatic.** A free hand that stays within `grabRadius(hold)` of a piece of rock for `HOVER_GRAB_DWELL`
  (0.12 s) closes on it — the dwell is what stops a hand sweeping across rock from snagging it. It leaves that hold by
  `HOVER_HYST` (12 mm) more than it came in by, so a hand resting on a rim does not chatter in and out of it. Decoys,
  runes and the summit are taken the same way and keep their events. Coming off a hold before the fingers close is the
  `miss` event, and one hand reports at most one every `MISS_COOLDOWN` (0.30 s).
- **Letting go is a stick push.** While a hand grips, pushing ITS OWN stick past `RELEASE_DEADZONE` (0.35 of full
  deflection) opens the hand, and the same push is already steering it. Under the deadzone a gripping hand does not move,
  so a resting thumb cannot drop you. It is the push and not the pushed stick: the stick must come back inside the
  deadzone before it can let go again, or the stick that steered a hand onto rock would drop it the frame after it closed.
  And it has to mean it: the push must hold past the deadzone for `RELEASE_CONFIRM` (0.016 s, two 120 Hz steps), so a
  thumb that clips the line on its way somewhere else keeps its hand. One stick moves one hand, so no single thumb can
  ever let go of both.
- **After a hand comes off rock** that hold is locked out of that hand (`_skipId`) until the hand is `SKIP_CLEAR` (4 cm)
  outside its grab radius — a distance, never a timer, so a parked hand can never be taken back by a hold with no input
  at all — plus a `REGRIP_LOCK` (0.14 s) beat before any rock can be taken. The hold lock holds in EVERY phase, the
  grace window included (see below); falling waives only the beat, so a hand that reaches other rock mid-fall can close
  on it inside the window.
- **The right hand does not grab while the web line is out** (`web.mode` other than `idle`): a hand that is aiming, or has
  just shot, must not snag a hold and cancel the shot.
- **Mid-swing it takes a reach at THAT rock.** While `phase === 'swinging'` a hand only closes on a hold its own stick
  is SENDING it to: the stick past `RELEASE_DEADZONE` and the resting place it picks (`shoulder + stick`, the same
  target `updateHand` springs to) inside that hold's radius, for the whole dwell. Both hands are free on the line and
  ride the body across the whole face, so on a wall with rock everywhere a parked hand is inside some hold within a few
  frames and every swing died as it began. An ANGLE is not enough to tell a reach from a pump — a pump is a stick swept
  through the ring and it sits inside any given 45° arc for 0.61 s of a 1.4 s cycle, five dwells — but where the stick
  parks the hand is: a pump sends it to arm's length, past everything. Catching rock mid-swing still ends the swing; it
  just has to be something you did.
- **A hand that slips takes nothing until it has rested.** `SLIP_REST` (0.15 stamina). Two holds whose radii overlap —
  every route has such a pair — otherwise gave a spent hand somewhere to go the instant it came off: slip off A, close
  on B, slip, close on A, for ever, on a hand that could never hold.
- **Why the lock survives the fall.** A push on both sticks from a two-hand hang is release, release, fall — and nothing
  may weld the hands back onto the same two holds a tenth of a second later (B43: nothing stops a fall; and the hands
  came back with the release latch down and the thumbs still buried, so you could not even let go again). `CFG.GRACE` is
  unchanged and still saves you: it has to be a hold you had not just let go of, which is what reaching for one is.

**The web-zip's gesture (B50).** One rule, and the same one on both devices: **hold to aim, let go to fire, tap to let go
of the line.** Hold the WEB pad (or the right mouse button) and drag to aim — the reticle follows, and *you may do this with
both hands on the rock*: aiming never releases a hand, because losing one costs the whole cliff (B43). Lift to fire. The
line flies, bites, and **both hands come off at that moment and not before**; you then swing with **nothing held at all** —
the left stick pumps and reels, the right stick still steers the right hand toward rock. A **tap** on the pad, or a right
click, lets go and throws you with the speed you had. Nothing about the swing is a dead-man's switch: the thumb that fired
the shot is already off the pad, so "the pad is no longer held" cannot mean "cut the line" — it used to, and it severed the
line one step after it attached, turning every shot on a phone into a fall. A press-and-hold on the pad while attached is
NOT a release, so a thumb resting there is harmless. Nor is a GRIP tap: reaching for rock with the right hand while
swinging is a grab, and it reaches the hand — it neither cuts the line nor is swallowed. A **brush** of the pad — pressed
and lifted inside the tap window without a drag — does nothing at all: it used to fire an unaimed shot straight up, which
always bit and took both hands off the wall, so with no rope a stray touch killed you. While swinging the body is clamped to `|x| ≤ SWING_MAX_X` (4.2, the
same clamp the anchor gets): a long line pumped sideways used to carry the climber to x = 7.40, off a cliff 9 m wide.

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
export function createInput({ hud, keyboard = true, win, now, mouse, getHands, surface = mouse }) → { read(): Input, dispose() }   // input.js — touch/mouse on hud.sticks + hud.webButton (pointer events), and the LOOK DRAG on `surface`, the canvas: a pointer that reaches it was not on a control, which is how the gesture stays out of the sticks (hit region, not z-index). Keyboard WASD / arrows, Shift + a stick turns the head, Escape centres both keyboard sticks (which is how the keyboard re-arms a release); sticks: position mapping, zero and `active` false the moment the finger lifts; keyboard: integrating virtual stick that holds its value, `active` only while a key is down; the WEB pad fills `web` (and `R.web`) and leaves `R` to the right stick, and a press there becomes an aim only once it commits (held past 250 ms, or dragged past 0.15 of the pad radius) so a brush does nothing; the right mouse button is hold-to-aim and click-to-cut, and neither button grips. `win` and `now` are injected so the tests can drive it headless

// world-light
export async function createWorld({ renderer, scene, route, tier }) → world             // world.js — loads textures + HDRI itself (paths below)
world.wallZ(x, y) → number; world.holdZ(hold) → number
world.update(dt, state, camera, events)               // holds glow when hovered/lit, decoys fall, particles, time-of-day from state.night. `events` fires the decoy dust on 'crumble', so it lands the frame the hand comes off
world.setTier(tier)
world.holds → THREE.Group of InstancedMesh; world.holdMeshes → that list        // B52: plain holds are instances of 12 unit-scale prototype blobs, not one deformed mesh each, so the cost of the rock does not grow with the number of holds. `world.holds` used to be the single merged Mesh; nothing outside world.js reads it. Runes, the summit and the decoys keep a mesh of their own; `world.chalk` and the contact skirts are still one merged mesh each

export function createPost({ renderer, scene, camera, tier }) → post                      // post.js — EffectComposer: RenderPass → UnrealBloom → vignette/grain ShaderPass → OutputPass
post.render(dt); post.resize(w, h); post.setNight(t01); post.setTier(tier)

// arms-camera
export async function createArms({ scene, tier, shoulder, holdZ }) → arms                // arms.js — loads assets/models/hands/realistic_hand.glb (left = mirrored), builds forearm + sleeve per side, 2-bone IK from shoulder, finger curl from Hand.curl (use the model's 'Grab' clip or bone rotation), tremble from Hand.tremble. `shoulder` and `holdZ` are passed in so arms.js imports neither the sim nor the world.
// ONLY THE HAND MESH IS DRAWN (B44, B49). The forearm, sleeve, cuff, rim, cord and bead are still built — the IK needs the arm to place the wrist and the finger direction — but every one of them is visible = false, and the group holds no other geometry. The hand GLB is watertight and closes itself at the wrist, so nothing may be added there to "cap" it: the blue plug that used to sit at each wrist was closing a hole that does not exist, and it read as a balloon. If the wrist end ever looks wrong, fix the lighting or the glove shader, not by adding an object
arms.update(dt, state, wallZ, camera)
export function createCameraRig(camera) → rig                                           // camera.js — follows body, breathing, roll toward loaded arm, look-up bias toward the hands, fall/catch shake, fov kick on grab
rig.update(dt, state, wallZ, events, lookIn, aim)     // lookIn = Input.look, aim = aimPoint(state) while aiming (else null): aiming pulls the eye back and turns the view to the anchor
                                                      // lookIn arrives in DEGREES, already clamped to the arc the hands allow (the table is in input.js), so the rig only decides how fast the
                                                      // head follows: LOOK.rate 8 under a finger, settle 5 when nothing is dragging, hurry 25 while lookIn.homing (the value is already eased,
                                                      // and easing it twice took the view 0.82 s home instead of 0.47). Looking is never gated: with both hands on the rock it is the neck
rig.setPortrait(isPortrait); rig.kick(...)
export function createWebLine({ variant, segments }) → line                              // webLine.js — the line as real geometry, lashing as it flies
export function applySpiderSkin(root, { variant }) ; spiderUnlocked() / unlockSpider() / spiderSkin() / setSpiderSkin(v)   // spiderHand.js — the egg, remembered per device

// hud-audio
export function createHud(root) → hud                                                    // hud.js — owns all DOM under #hud, #title, #end and #custom
hud.sticks = { L: HTMLElement, R: HTMLElement }       // no `hud.grips`: the GRIP pills went with the buttons (B51)
hud.webButton                                         // input.js binds pointer events to it; it is a drag pad, not a press-and-hold button. There is no lookButton: B47 removed it
hud.update(state, events)                             // stamina arcs, knob positions come from input via hud.setStick(side, x, y), each stick's own gripping/slipping state, height meter, rune progress, fall count, the web-zip's own state on the WEB pad
hud.setStick(side, x, y)                              // called by input.js each frame with the stick vector
hud.message(text, ms = 2200); hud.showTitle({ touch, seeds, seed }); hud.hideTitle(); hud.onStart(cb); hud.onSeed(cb); hud.showEnd(stats); hud.onRestart(cb)
hud.onMenu(cb)                                        // the Menu button asks for the title screen back: mid-climb behind one confirmation, straight from the end screen. Unwired it reloads the page. `showTitle` resets its own shell (end screen, dead veil, pending end timer), so the integrator only has to rebuild the game state
hud.onPause(cb)                                       // cb(true/false) around the mid-climb confirmation, so the sim can be frozen while the question is on screen
hud.openCustom() / closeCustom() / refreshCustomBtn() / onSkinChange(cb)                 // the hand panel behind the ✦ button
export function createAudio() → audio                                                   // audio.js — WebAudio; call audio.unlock() on first user gesture
audio.handle(events, state, dt)                       // wind bed follows height/night, cues per event, heartbeat when any stamina < 0.25
audio.setMusic(url); audio.setMuted(b); audio.muted
```
Required DOM ids in `index.html`: `#gl` (canvas), `#hud`, `#title`, `#end`, `#stick-l`, `#stick-r`,
`#ctl-l`, `#ctl-r`, `#web`, `#height`, `#runes`, `#msg`, `#falls`, `#mute`, `#vig`, `#seeds`, `#custom`, `#customBtn`, `#menuBtn`, `#confirm`, `#boot`.
(`#grip-l` / `#grip-r` are gone with the GRIP buttons — B51, and `#look` with the LOOK button — B47. A hand's own state
is on its stick instead: `.stick.gripping`, `.stick.slipping`, and `.stick.miss` for the shake.)

**Control layout invariant (B34).** `#web` is the first child of `#ctl-r`: pad, then stick. `#ctl-l` has no pad any
more — B47 deleted `#look` — and neither column has a GRIP pill any more (B51), so the left column is the stick alone.
`#web` must stay in the flow — do not give it `position: fixed` and a z-index above the HUD again. The pads used to
float over the middle of the screen and landed inside the bottom of the stick rings, where they took a thumb sliding
down a stick. The cluster is anchored at its bottom edge, so hiding `#web` while the egg is locked leaves the stick
exactly where it is.
The same rule is what keeps the look drag honest: everything the HUD claims is a `pointer-events: auto` child of a
`pointer-events: none` HUD, so a pointer that reaches `#gl` is by definition not on a control.

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
replaces them. `debug` offers `start() / restart() / teleport(y) / tap(side) / hold(side, bool) / fall() / autopilot(b)` and the
`pause` flag — the one member of `debug` the game itself writes: `hud.onPause` raises it while the mid-climb
confirmation is on screen, so a one-hand hang cannot drain away under the question,
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
  `?fps=1` draws the same figures on the screen for a reading taken by hand on a real device (B27): the 2-second
  average as a large coloured headline (teal ≥ 30, amber ≥ 24, red below), then the min fps since the climb started,
  the watchdog step-down count, the tier name, the pixel ratio now, the drawing-buffer size, draw calls, triangles,
  phase and height. It sits below the HUD's top row and inside the safe area, and reads nothing that `perf` and the
  renderer do not already hold — the step count is `(tier.pixelRatio − renderer.getPixelRatio()) / 0.25`.
- Never touch files you do not own; report contract problems to the integrator instead of working around them.

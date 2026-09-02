# Rock Climber: The Ritual — first-mockup design

Date: 2026-09-01. Owner: Maor. Decision authority delegated to Claude for this mockup ("I trust you, keep going").

## Goal
A 3D first-person climbing game for iPhone Safari (touch) and Mac (keyboard/mouse), where each hand is controlled independently by its own on-screen joystick, with a grip button above each joystick. The first mockup must already look *beautiful*: real PBR rock, dusk sky lighting, glowing ritual runes, bloom, dust, fog, and a polished HUD. Not a wireframe.

## Fiction
At dusk a lone climber ascends a sacred cliff to complete an old ritual: touch every rune carved into the rock on the way up and reach the altar at the summit before the light dies. Runes glow teal against warm sunset rock.

## Camera and view
First person. Camera sits at the climber's eyes, about 0.6 m from the wall, looking at the wall and slightly upward toward the hands. Both forearms and hands are visible. The camera drifts with breathing, tilts toward the arm carrying the body's weight, and follows the body up. The cliff is ~8 m wide so the dusk sky and a fog-filled valley are visible at the edges and when looking down.

## Controls
Phone (portrait or landscape):
- Left joystick (bottom-left) moves the left hand inside its reach circle; right joystick moves the right hand. Stick position maps to hand position (push up-right → hand goes up-right, release → hand drifts back toward the shoulder).
- A GRIP button sits above each joystick. Tap to grab when the hand is over a hold; tap again to let go. Toggle, not hold, so two thumbs are enough.
- A hand auto-releases when its stamina hits zero.

Mac:
- Mouse can drag the on-screen joysticks and click the GRIP buttons.
- Keyboard: W/A/S/D moves the left hand, Q toggles left grip. Arrow keys move the right hand, Enter (or /) toggles right grip. Keyboard input is velocity-based, clamped to the reach circle.

## Simulation (pure logic, unit-tested, `src/sim.js`)
Units are meters, wall plane is z = 0.
- Body = shoulder center (x, y). Shoulders at body + (∓0.2, +0.1). Arm reach 0.72 m.
- Hand: position, target, gripping flag, hold id, stamina 0..1.
- Free hand eases toward its target (exponential, ~12/s). Target = shoulder + stick × reach (touch) or integrated velocity clamped to reach (keys).
- Grab: on GRIP tap, if a hold is within 0.16 m of the hand → attach (hand snaps to hold). Release: GRIP tap while attached, or stamina 0.
- Body target while ≥1 hand grips = mean of gripped hold positions + (0, −0.42); body eases there (~6/s). When no hand grips, body falls under gravity; a 0.25 s grace window still allows a catch. Falling more than 1.5 m below the last gripped height = fall → respawn at the last checkpoint rune with both hands attached to its start holds.
- Stamina: per hand. Drains 0.06/s while both hands grip, 0.22/s when it's the only gripping hand; refills 0.15/s while free. Rune holds are rest holds: no drain, fast refill (0.5/s).
- Route: generated from a seed. Holds alternate sides, dy 0.35–0.6, dx within ±0.45, every hold reachable (≤ 0.9 × reach from the projected shoulder). A rune checkpoint every ~8 m; summit altar at ~42 m. Grabbing the summit rune completes the ritual.

## Rendering (`src/world.js`, `src/hands.js`, `src/main.js`)
three.js 0.185 from local node_modules via importmap (offline-capable on LAN).
- Renderer: ACES filmic tone mapping, sRGB output, pixel ratio ≤ 2, soft shadows from one warm directional "low sun" light that follows the climber; cool hemisphere fill. HDRI `kloppenheim_06_puresky` (Poly Haven, CC0) as background and PMREM environment.
- Wall: plane 8 × 60 m, ~70k vertices displaced with layered simplex noise for ledges and cracks, `rock_face_03` 2k PBR set (color, normal, roughness, AO, displacement). Hold meshes: noise-deformed low-poly blobs with `rock_boulder_dry` PBR and a chalk highlight. Rune holds: same shape plus an emissive canvas-drawn sigil, a teal point light, and bloom.
- Hands: procedural stylized hands — palm (rounded box), five jointed capsule fingers that curl on grip and tremble at low stamina; forearm and upper arm as capsules via 2-bone IK from the shoulder with a downward pole. Skin material plus a fabric sleeve with a wrist band.
- Atmosphere: FogExp2 tinted to the horizon, drifting dust motes near the camera (additive points), embers around runes, soft cloud sprites far below, distant mountain silhouettes.
- Post: EffectComposer → RenderPass → UnrealBloomPass (threshold 0.85, strength ~0.55) → custom vignette + film grain pass → OutputPass. Bloom at half resolution on mobile; automatic pixel-ratio step-down if FPS < 40.

## HUD (`index.html`, `src/hud.js`)
Dark warm palette with teal rune accent (#7fe0ff). Title screen: "Rock Climber" small, "THE RITUAL" in Cinzel with a rune sigil, tap/click to begin, controls card adapted to touch vs keyboard. In-game: two joystick rings with a stamina arc around each, GRIP pill above each ring (lit when gripping, shakes on a miss), height meter and rune progress at top center, short cinematic messages ("You fell." / "The ritual is complete."). iOS-safe: viewport-fit=cover, safe-area insets, no tap highlight, no double-tap zoom, AudioContext resumed on first touch.

## Audio (`src/audio.js`)
WebAudio synth only: filtered-noise wind with slow LFO, grip thud, release whoosh, rune chime, fall whoosh, heartbeat when stamina is low. Mute toggle persisted in localStorage.

## Out of scope for the mockup
Feet/legs, multiple routes, leaderboard, real 3D character model, multiplayer, native app packaging.

## Verification
- `node --test` on `src/sim.js` (reach clamp, grab/release, body target, stamina, fall + respawn, route reachability).
- Desktop preview via `python3 -m http.server 8787` (launch entry `rock-climber`), console clean, screenshots in desktop and mobile emulation after each batch.
- iPhone Safari over LAN: `http://10.100.102.122:8787`.

## Build order
1. `src/sim.js` + tests (route, hands, grip, body, stamina, fall).
2. Renderer + wall + sky + lights (static beauty shot).
3. Hands + IK + camera rig, wired to controls.
4. Holds, runes, bloom, particles, fog.
5. HUD, title, messages, audio, mobile polish, performance guard.

---

## Decisions from the design interview (wizard, 2026-09-01 evening)
Answered by Maor via the clickable wizard; these override the draft above where they differ.

| Topic | Decision | Consequence |
|---|---|---|
| Hand physics | **Kinematic with physical feel** | No pendulum/momentum sim. Hands and body use spring-damped easing, weight shift, sway on one-arm hangs, finger curl, low-stamina tremble. |
| Phone | iPhone 14/15 | dpr capped at 2, 2K wall textures, 1024 shadow map on phone (2048 desktop), half-res bloom. |
| Frame rate | **30 fps acceptable** for more detail | Quality-first tier; FPS watchdog only steps pixel ratio down below ~24 fps. |
| Light | Dusk darkening into night with height | Exposure, sky/env intensity, fog color, sun vs moon all interpolate on body height. Stars fade in. |
| Hands | **Real rigged model if a free one exists** | Background agent researching. Fallback: procedural hands with chalk, finger tape, knuckle creases, sleeve. Decision recorded when the report lands. |
| Rope | **Roped** | Visible rope from harness to a summit anchor. Releasing both hands drops you by the rope slack (~1.3 m) then the rope catches you; you hang, recover some stamina, keep climbing. No death, falls are counted. The "fall consequence" question was therefore skipped. |
| Body | Forearms and upper arms only | plus harness/rope at the bottom edge. |
| Joystick | Stick position = hand position in the reach circle | Release drifts the hand back toward the shoulder. Keyboard integrates a virtual stick that holds its value. |
| GRIP | Tap toggle plus arming | Tap on a free hand away from holds arms it; it grabs the next hold within snap radius. |
| Stamina | Medium: per hand, runes are rest holds | One-arm hang drains fast, two arms slowly, free hand refills, slips at zero. |
| Scope | One crafted route (~40 m), runes, summit altar | Seeded generation, hand-tuned constants. |
| Orientation | Portrait first | Landscape still works. |
| Ritual | Light every rune; altar completes it | Runes = checkpoints + rest holds; sky darkening is the soft clock. |
| Palette | Warm dusk rock, teal runes | #2a1c14 #7a5238 #d99a5b #5b3d6e accent #7fe0ff |
| Audio | **Find a good free, properly licensed music track** (plus synth SFX) | Background agent: CC0 / CC-BY / public-domain track with direct download, attribution in CREDITS.md. |
| Hosting | LAN first (iPhone test from the start); Xcode not necessary; **deploy via GitHub Pages / Actions** later | three.js vendored into `vendor/` so the static site deploys as-is. |

Submitted from Safari 26.6 on the Mac (1512×982 @2x); the iPhone UA will be captured on its first load.

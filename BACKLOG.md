# Backlog — Rock Climber: The Ritual

Everything known to be worth doing, in one place. Format mirrors the B-number backlog Maor uses
on his other projects (schema confirmation pending from the ASUS; IDs and layout will be adjusted
to match once it arrives).

**Status:** `open` · `next` · `doing` · `done` · `parked` (deliberately not doing yet)
**Size:** `S` under an hour · `M` a session · `L` more than a session
**Area:** feel · world · hands · web · hud · audio · perf · mobile · infra

Last updated 2026-09-02.

---

## Open — ranked

| ID | Title | Area | Size | Why it matters |
|---|---|---|---|---|
| **B01** | **Maor plays it and reports** | feel | S | Nothing here is verified by a human yet. Every feel judgement in this file is mine, from screenshots and bots. This gates most of the list below. |
| **B02** | Web-zip overhaul: make it *feel* like the movies | web | L | It works but it is mechanical. Wants: aim reticle that reads on rock, the line whipping out rather than sliding, a real yank when it goes taut, speed streaks while swinging, a release that visibly throws you. |
| **B03** | Zip HUD: cooldown, aim state, and a hint the egg exists | web/hud | M | Once unlocked there is nothing on screen about the web. You cannot tell when you can shoot again. |
| **B04** | Web-zip on touch | web/mobile | M | Aiming is hold-the-right-grip, which on a phone is the GRIP pill. Never tested on a real phone; probably needs its own aim pad like LOOK got. |
| **B05** | Decoy feedback | feel/world | S | A decoy crumbling has a sound and drops away, but no dust burst and no HUD tell. Never seen in a real play session. |
| **B06** | Verify the fall + death screen on a phone | feel/mobile | S | Built and measured in a desktop browser only. The red bloom and the 22-degree fov widen may be too much on a small screen. |
| **B07** | Chalk: using it, and running out | feel | M | The hands are chalked but it is decoration. Chalk as a resource that buys back grip would give the free hand something to do. |
| **B08** | Route variety beyond one seed | world | M | One 24 m route, seed 7. No reason not to offer a few, or a daily seed. |
| **B09** | Second rope / difficulty modes | feel | M | The rope saving you once is harsh for a first play and trivial for a good one. A choice at the title would fix both. |
| **B10** | Landscape pass on a phone | mobile | S | Portrait is designed; landscape is only "not broken". |
| **B11** | Music: a second track, and ducking under the wind | audio | S | One 4-minute loop for a 6-minute climb, and it fights the wind roar during a plunge. |
| **B12** | Perf on an actual iPhone | perf/mobile | M | 33 fps measured in a desktop browser at phone tier, never on the device. The target was 30. |

## Parked — deliberately not now

| ID | Title | Why parked |
|---|---|---|
| **B20** | Critic scoring of the build | The orchestrated run was stopped at the usage guard before any critic scored it. Worth doing when usage allows; it is the only objective read on how it looks. |
| **B21** | Endless mode after the summit | Scope. The crafted route is the deliverable. |
| **B22** | Feet and legs | Cost, and the two-hand mechanic does not need them. |
| **B23** | Rigged Spider-Man hand from a real model | No permissively licensed rigged hand exists that can be downloaded without an account. The shader cover is better than what is available. |

## Done

| ID | Title | Landed |
|---|---|---|
| **B30** | First playable: wall, hands, camera, HUD, audio | 2026-09-02 |
| **B31** | Deploy on GitHub Pages via Actions, tests gate the deploy | 2026-09-02 |
| **B32** | Route shortened to 24 m; summit blowout and red flood fixed | 2026-09-02 |
| **B33** | Slower stamina, whole-rock grip, rope saves once, decoy rocks | 2026-09-02 |
| **B34** | Desktop mouse control; grips on the two mouse buttons | 2026-09-02 |
| **B35** | Look around with a hand free, including down into the drop | 2026-09-02 |
| **B36** | Spider-Man glove: shader cover on the game's own hand | 2026-09-02 |
| **B37** | ARACHNID unlock and the customisation panel | 2026-09-02 |
| **B38** | Web-zip: aim, fire, swing on a real pendulum, cooldown | 2026-09-02 |
| **B39** | Hold types (jug/edge/crimp/sloper) and a difficulty curve | 2026-09-02 |
| **B40** | Smoothness retune + playability tests that guard it | 2026-09-02 |
| **B41** | The plunge and the death screen | 2026-09-02 |
| **B42** | LOOK button fixed on touch (it did nothing before) | 2026-09-02 |

---

## Known risks

- **Nobody has played this.** 67 tests and a bot that tops out prove it is not broken. They do not
  prove it is good. B01 is the only thing that can.
- **No critic has scored it.** The rubric from the orchestrated run was never applied (B20).
- **Phone is inferred, not measured.** Every "phone" number came from a desktop browser emulating
  one (B06, B12).

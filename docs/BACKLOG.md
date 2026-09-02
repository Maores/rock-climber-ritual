# Backlog — Rock Climber: The Ritual

Source of truth. One table per domain section; a row joins exactly one section.

**Status** is one of: `proposed` · `approved` · `parked` · `rejected` · `shipped (vX.Y.Z)`
Shipped rows stay forever, as history. Rejected rows keep their reason.

**IDs** are `B<n>`, immutable, never reused. Take the next one by re-reading the highest number
in this file immediately before writing, never from memory.

**Notes** is where the value is: what is known now, what is proposed, the triage decision with
its date, and after shipping, what was actually built and how it was verified. Rows grow over
their lifetime; nothing is overwritten.

There is no priority column and no estimate column on purpose. Priority is the prose block below.

---

## Order of work, proposed by Claude 2026-09-02 — not yet sealed by Maor

1. **B1** — Maor plays it. Nothing below is trustworthy until a human has climbed it.
2. **B14** — the web-zip overhaul, since Maor asked for it directly.
3. **B15, B16** — the zip's HUD and its touch path, which the overhaul depends on.
4. **B24, B25** — confirm the fall, the death screen and the frame rate on a real iPhone.
5. Everything else, after B1 reorders it.

---

## Feel and controls

| ID | Item | Source | Status | Notes |
|----|------|--------|--------|-------|
| B1 | Maor plays the game end to end and reports what feels wrong | Claude 2026-09-02, self-review | proposed | Everything shipped so far was verified by screenshots, scripted harnesses and a bot. 67 tests and a bot that tops out prove it is not broken; they cannot prove it is good. Route length, grab feel, swing timing and the difficulty curve are all my judgement, unmeasured against a person. This row gates most of the open list. |
| B2 | Hand felt loose and magnetic when moving | Maor 2026-09-02 | shipped (v0.1.0) | Two causes. The hand spring was 16 rad/s and under-damped, so it overshot where you aimed; now 11.5 and critically damped, about 0.20 s a move. The magnetism was the grab snap closing in 0.15 s, which read as being sucked in; now 0.3 s, so the fingers arrive. There was no positional magnet in the code, which is why this needed Maor's description to find. |
| B3 | Gameplay became a fight after the grab-radius tightening | Maor 2026-09-02, "the gameplay is a nightmare" | shipped (v0.1.0) | Measured the cause rather than guessing: the grab target had halved to 8.3 cm, 11.5% of the reach circle, at the same moment the hand slowed to 0.27 s a move. Retuned to a 9.2 cm crimp floor, a 2.8 cm fingertip allowance and 0.20 s hands; smallest target is now 16.7% of reach and a jug is still 1.6x a crimp. |
| B4 | Guard against the game silently becoming unplayable again | Claude 2026-09-02, after B3 | shipped (v0.1.0) | `test/playability.test.js`. Fails if any hold drops under 15% of the reach circle, if a hand takes over 0.30 s to move, if one-arm hang time falls under 5 s on any hold type, or if a steady bot cannot top out. The bot drives the real sim: 128 grabs, 0 misses, 0 slips, 0 falls, summit. B3 happened with every unit test green, which is why this exists. |
| B5 | You could grab past the rock onto bare wall | Maor 2026-09-02 | shipped (v0.1.0) | The radius was floored at a flat 16 cm, which on a small hold reached beyond the visible rock. It is now the hold's own size plus 2.8 cm of fingertip, so a crimp is a small target and a jug is a big one. |
| B6 | Chalk as a resource rather than decoration | Claude 2026-09-02 | proposed | The hands are visibly chalked and it means nothing. Chalking a free hand could buy back grip, which would give the resting hand a job and a reason to hang on a rune. Unscoped. |
| B7 | A second rope, or difficulty modes | Claude 2026-09-02 | proposed | One rope save is harsh on a first climb and trivial once you can climb. A choice at the title screen would serve both. Waiting on B1: this may be a non-issue. |

## World and route

| ID | Item | Source | Status | Notes |
|----|------|--------|--------|-------|
| B8 | The rocks were undifferentiated, so there was no difficulty | Maor 2026-09-02 | shipped (v0.1.0) | Four hold types with their own stamina cost: jug, edge, crimp, sloper, and a sloper drops you after 9 s however fresh you are. Difficulty rises with height: 16% poor rock in the first 8 m, 38% in the last. Crimps are visibly smaller so the wall can be read before it is touched. A route test asserts the curve so it cannot silently flatten. |
| B9 | Blue overlay appearing on some rocks | Maor 2026-09-02 | shipped (v0.1.0) | It was the teal waymark glyphs, painted on the wall every 2.6 m beside the route. Turned off, like the hover ring before them. The wall is read, not labelled. |
| B10 | Decoy rocks that crumble | Maor 2026-09-02, "fake rocks to trick the players" | shipped (v0.1.0) | 8 per route, generated beside the line and never on it, deliberately never the only way up. Identical to real rock until weighed, then they crack, drop away and are gone for good. Sound and physics done; visual feedback is B11. |
| B11 | A decoy needs a dust burst when it goes | Claude 2026-09-02 | proposed | It crumbles, sounds right and falls, but there is no puff of dust and nothing in the HUD. Never yet seen in a real play session, so its readability is unverified. |
| B12 | Route was ~210 grabs, too long for one sitting | Claude 2026-09-02 | shipped (v0.1.0) | The frozen reach and hang geometry caps a move at 0.228 m, so 40 m meant about 210 grabs. Shortened the route to 24 m with runes every 6 m: 125 holds. Tried raising the reach instead and reverted it, because a longer reach made a free hand steer toward the next hold rather than the one under it. |
| B13 | More than one route, or a daily seed | Claude 2026-09-02 | proposed | Generation is already deterministic per seed; only seed 7 is ever used. Cheap to expose, but pointless before B1. |

## The web-zip and the Spider-Man egg

| ID | Item | Source | Status | Notes |
|----|------|--------|--------|-------|
| B14 | Overhaul the web-zip so it feels like the films, not just works | Maor 2026-09-02 | proposed | It fires, bites and swings correctly, and it is mechanical. Wanted: an aim reticle that reads against rock, the line whipping out instead of sliding out, a real yank when it goes taut, speed streaks while swinging, and a release that visibly throws you. Nothing here changes the physics, which Maor already approved; it is all presentation. |
| B15 | The zip has no HUD at all | Claude 2026-09-02 | proposed | Once unlocked there is no cooldown indicator, no aim state and no hint the ability exists. You cannot tell when you may shoot again. Blocks B14 being legible. |
| B16 | The zip has no touch path | Claude 2026-09-02 | proposed | Aiming is a held right grip, which on a phone is the GRIP pill, and holding a pill while aiming with the same thumb is the exact mistake the LOOK button made (B23). Probably needs its own aim pad. Untested on a real phone. |
| B17 | Spider-Man hand | Maor 2026-09-02 | shipped (v0.1.0) | No permissively licensed rigged hand exists that downloads without an account, and the two no-login models found were single-mesh photogrammetry sculpts with no skeleton. Built as a shader on the game's own rigged hand instead: radial web across the back, rings around each finger, navy cuff, raised piping that bends the normal and goes matte. Pattern matched to a reference photo Maor sent; palette sampled from a scan, which is gitignored. |
| B18 | The unlock, and making the glove a choice | Maor 2026-09-02 | shipped (v0.1.0) | Typing ARACHNID on the title screen unlocks it for good on that device; letters never double as press-any-key. A customisation panel offers classic, stealth and bare, remembered per device, reachable afterwards from the ✦ button. Changing it rebuilds the hands, which is the honest way to re-skin a skinned mesh. |
| B19 | The 🤘 pose while aiming | Maor 2026-09-02 | shipped (v0.1.0) | Promised in the mockup and missing from the first build. While aiming, the middle and ring fingers fold onto the shooter and the rest stay out, sampled from the model's own grab clip so the curl is the rig's own. |
| B20 | The web-shooter sound | Maor 2026-09-02, "find the original web shooting sound" | shipped (v0.1.0) | The film's thwip is copyrighted audio and was not used. Built instead from a real recorded air swish (Swishes Sound Pack, artisticdude, OpenGameArt, CC0, credited) with a synthesised shooter click and a pressurised spray tail, pitch-varied per shot. 2 KB. |
| B21 | Swing physics on the line | Maor 2026-09-02 | shipped (v0.1.0) | A position-based constraint: integrate, project the body back onto the circle around the anchor, drop the radial velocity. Stable at any frame rate, unlike a stiff spring. The left stick pumps and reels; letting go keeps your velocity so a timed release throws you; catching rock mid-swing returns you to climbing. 8 tests. |

## HUD, camera and onboarding

| ID | Item | Source | Status | Notes |
|----|------|--------|--------|-------|
| B22 | Look around with a hand free, including down into the drop | Maor 2026-09-02 | shipped (v0.1.0) | Only with exactly one hand on the rock, because the free arm is what lets you turn. The reachable arc follows the free arm: hanging off your right you can crane left. 180 degrees across, 62 up, 85 down, and staring down widens the lens for vertigo. |
| B23 | The LOOK button did nothing on iPhone | Maor 2026-09-02 | shipped (v0.1.0) | Holding it only enabled looking; the direction had to come from a second thumb on a stick, so pressing it alone did nothing at all. It is a drag-pad now, one thumb, press and drag. Pressing it with both hands on the rock says why nothing happens instead of feeling broken. |
| B24 | Falling animation and a death screen | Maor 2026-09-02 | shipped (v0.1.0) | With the rope spent, losing both grips is the whole cliff: no catch, terminal velocity, the head pitches over, the world turns, the lens widens 22 degrees with speed, the wind roars up with it. The ground lands one heavy hit, the screen blooms red and the end screen reads "You fell". Measured 19.7 m to the ground at 16.8 m/s. Verified in a desktop browser only, which is B25. |
| B25 | Verify the fall and death screen on a real phone | Claude 2026-09-02 | proposed | The red bloom and the 22-degree lens widen were tuned on a desktop screen and may be too much on a phone. |

## Audio

| ID | Item | Source | Status | Notes |
|----|------|--------|--------|-------|
| B26 | A second music track, and ducking under the wind | Claude 2026-09-02 | proposed | One 4:24 loop for a climb that runs longer, and it competes with the wind roar during a plunge. |

## Performance and mobile

| ID | Item | Source | Status | Notes |
|----|------|--------|--------|-------|
| B27 | Measure the frame rate on an actual iPhone | Claude 2026-09-02 | proposed | 33 fps was measured in a desktop browser emulating a phone, against a target of 30. That is an inference, not a measurement. |
| B28 | Landscape pass on a phone | Claude 2026-09-02 | proposed | Portrait is designed. Landscape is only known not to be broken. |

## Infrastructure

| ID | Item | Source | Status | Notes |
|----|------|--------|--------|-------|
| B29 | Deploy on GitHub Pages through Actions | Maor 2026-09-02 | shipped (v0.1.0) | Public repo Maores/rock-climber-ritual. The workflow runs the tests first and publishes only if they pass. The Crytek reference stills, the run's evidence screenshots and the Spider-Man scans are deliberately excluded and verified 404 on the live site. |
| B30 | Critic scoring of the build against the frozen rubric | orchestrated run 2026-09-02 | parked | The run was stopped at Maor's usage guard before any critic scored it, so the 7-criterion rubric was never applied. It is the only objective read on how the game looks. Parked on cost, not on merit. |
| B31 | Endless mode after the summit | design interview 2026-09-01 | parked | Maor chose one crafted route with an ending. Recorded so the option is not lost. |
| B32 | Feet and legs | design interview 2026-09-01 | rejected 2026-09-01 | Maor chose arms only. The two-hand mechanic does not need them and they cost animation work. |
| B33 | Ship a rigged Spider-Man hand from a downloaded model | Maor 2026-09-02 | rejected 2026-09-02 | Sketchfab gates downloads behind a login. The two models that download without one are single-mesh photogrammetry sculpts with no skeleton and a scrambled UV atlas. The shader cover in B17 is better than anything available, and no Marvel-derived geometry ships. |

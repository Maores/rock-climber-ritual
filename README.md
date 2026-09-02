# Rock Climber: The Ritual

A first-person climbing game for the phone and the desktop browser. Each hand has its own
joystick and nothing else: push a stick and that hand reaches, hold it over the rock and the hand
grabs on its own, push that stick again to let go. Hanging drains a hand and the glowing runes are
rests. **Nothing catches you**: lose both hands and you fall the whole cliff. Light every rune and
reach the summit altar.

**Find your own way.** The cliff is a field of holds, not a path: about 1965 of them scattered
over 7.2 m of the wall and 24 m of height, at spacing you can always climb. There is no correct
line. The three glowing runes and the summit altar are the only fixed points — everything between
them is your choice of rock. Every hold has somewhere to go from it, and start → each rune → the
altar is proved reachable for every seed by a graph check in the tests.

**Four routes.** The title screen offers Ritual, Ladder, Serpent and Ordeal. Generation is
deterministic per seed, so each name is a fixed cliff, not a shuffle. Being honest about what
that now means: with 1900 holds drawn from the same distribution the four are close to identical
in difficulty — poor rock up high is 49-56% on all of them, against 13-15% low. What a
seed still decides is where the three runes sit, and so how far across the face a climb has to
travel: Ordeal is the widest at 8.48 m of side-to-side, Serpent the most direct at 5.71 m. Picking
one reloads the page with `?seed=` in the URL, so a link opens the same climb for anyone. Any
other `?seed=<n>` generates under the same rules — seeds 1 to 40 are all checked by the tests.

**Play:** open the deployed page, or run it locally.

```bash
python3 tools/devserver.py 8787   # then open http://localhost:8787/
```

Controls on a phone: two thumbs, one per stick, and no buttons. Push a stick — that hand reaches.
Hold it over the rock and the hand grabs on its own. Push that stick again to let go. Climb hand
over hand and rest on the glowing runes. Drag anywhere else on the screen to look around; the view
stays where you leave it. The stamina arc runs around each stick, and if you have found the WEB
pad: hold it to aim, lift to fire, tap it to let go of the line.

On a desktop: `WASD` for the left hand and the arrows for the right — push to let go, and to
reach. Move the mouse and whichever hand is hanging free follows it. `Shift`-drag looks around,
`Esc` re-centres the sticks, `M` mutes.

## Built with

Vanilla three.js 0.185 (vendored, no build step, no bundler). `src/sim.js` and `src/route.js`
are pure logic with no renderer imports, covered by `node --test test/`.

| Module | Owns |
|---|---|
| `src/sim.js`, `src/route.js`, `src/input.js` | climbing simulation, route generation, touch/mouse/keyboard input |
| `src/world.js`, `src/env.js`, `src/post.js` | cliff, holds, runes, decoys, dusk-to-night lighting, bloom and grain |
| `src/arms.js`, `src/camera.js` | rigged hands and arms, camera rig |
| `src/hud.js`, `src/audio.js` | HUD, title and end screens, synthesized sound |
| `src/main.js` | wiring and the frame loop |

`CONTRACTS.md` is the interface contract between those modules.

## Credits

- "Realistic Hand" by J-Toastie via [Poly Pizza](https://poly.pizza/m/2lEkhDqfQf) — CC-BY 3.0
- "Ritual" and "Ossuary 6 - Air" by Kevin MacLeod ([incompetech.com](https://incompetech.com)) — CC BY 4.0
- `rock_face_03`, `rock_boulder_dry`, `kloppenheim_06_puresky` by [Poly Haven](https://polyhaven.com) — CC0
- Fonts: Cinzel and Inter via Google Fonts

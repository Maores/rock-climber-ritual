# Rock Climber: The Ritual

A first-person climbing game for the phone and the desktop browser. Each hand has its own
joystick and its own GRIP button: steer a hand to a hold, tap GRIP, then move the other one.
Hanging drains a hand, the glowing runes are rests and checkpoints, and the rope catches every
fall. Light every rune and reach the summit altar.

**Play:** open the deployed page, or run it locally.

```bash
python3 tools/devserver.py 8787   # then open http://localhost:8787/
```

Controls on a phone: two thumbs, one per stick, GRIP above each.
On a desktop: `WASD` + `Q` for the left hand, arrows + `Enter` (or `/`) for the right, `M` mutes.
The sticks can also be dragged with the mouse.

## Built with

Vanilla three.js 0.185 (vendored, no build step, no bundler). `src/sim.js` and `src/route.js`
are pure logic with no renderer imports, covered by `node --test test/`.

| Module | Owns |
|---|---|
| `src/sim.js`, `src/route.js`, `src/input.js` | climbing simulation, route generation, touch/mouse/keyboard input |
| `src/world.js`, `src/env.js`, `src/post.js` | cliff, holds, runes, rope, dusk-to-night lighting, bloom and grain |
| `src/arms.js`, `src/camera.js` | rigged hands and arms, camera rig |
| `src/hud.js`, `src/audio.js` | HUD, title and end screens, synthesized sound |
| `src/main.js` | wiring and the frame loop |

`CONTRACTS.md` is the interface contract between those modules.

## Credits

- "Realistic Hand" by J-Toastie via [Poly Pizza](https://poly.pizza/m/2lEkhDqfQf) — CC-BY 3.0
- "Ritual" by Kevin MacLeod ([incompetech.com](https://incompetech.com)) — CC BY 4.0
- `rock_face_03`, `rock_boulder_dry`, `kloppenheim_06_puresky` by [Poly Haven](https://polyhaven.com) — CC0
- Fonts: Cinzel and Inter via Google Fonts

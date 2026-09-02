# Asset credits

All textures and HDRIs here are CC0 from Poly Haven (https://polyhaven.com):
- rock_face_03 (cliff wall PBR set)
- rock_boulder_dry (holds PBR set)
- kloppenheim_06_puresky (dusk HDRI)

## Music

- **"Ritual"** — Kevin MacLeod (incompetech.com)
  Licensed under Creative Commons: By Attribution 4.0
  https://creativecommons.org/licenses/by/4.0/
  - Track page: https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100466 (ISRC USUAN1100466,
    album "Wonders of Other Worlds", 2008, 4:24, described by the author as "very very slow piece featuring the alto flute")
  - Original file: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Ritual.mp3 (320 kbps, 10.7 MB)
  - Shipped as `assets/audio/theme.mp3`: re-encoded from the 320 kbps original to 160 kbps MP3 (5.3 MB) so the file
    fits the 6 MB budget; no other change (no cuts, no level or dynamics processing, no added parts). Played in-game at
    about 0.35 gain under the synthesised wind bed.
- **"Ossuary 6 - Air"** — Kevin MacLeod (incompetech.com)
  Licensed under Creative Commons: By Attribution 4.0
  https://creativecommons.org/licenses/by/4.0/
  - Track page: https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1500048 (ISRC USUAN1500048, part six
    of the "Ossuary" series, 2015, 4:10, described by the author as a "slow-moving drone of impending doom")
  - Original file: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Ossuary%206%20-%20Air.mp3 (256 kbps, 8.0 MB)
  - Shipped as `assets/audio/theme2.mp3`: re-encoded from the 256 kbps original to 160 kbps MP3 (5.0 MB) so the file
    fits the 6 MB budget; no other change (no cuts, no level or dynamics processing, no added parts). It is the night
    track (B61): loaded beside the theme, it takes over in a 2 s crossfade once the climb passes `state.night` 0.55,
    about the second rune, and is raised 1.8× in the graph (it is 5 LU quieter than the theme as published).
- Attribution for the tracks is shown in-game on the title screen footer (`src/hud.js`, footHtml(), from its CREDITS
  list; B61's entry for the second track is the integrator's to add there, alongside the one for "Ritual").

## Hand model

- **"Realistic Hand"** by J-Toastie via Poly Pizza — https://poly.pizza/m/2lEkhDqfQf — CC-BY 3.0
  (https://creativecommons.org/licenses/by/3.0/). Full note in `assets/models/hands/LICENSE.md`; credited in-game.

## Engine and type

- three.js (MIT) vendored under `vendor/three`.
- Fonts Cinzel and Inter served from Google Fonts (SIL Open Font License).

## Web-shooter sound

The film's own "thwip" is copyrighted, so the shot is built rather than lifted: a real recorded
air swish with a synthesised shooter click and a pressurised spray tail layered over it at
runtime.

- `audio/thwip.mp3` — one swish from the **Swishes Sound Pack** by artisticdude, OpenGameArt,
  **CC0** (https://opengameart.org/content/swishes-sound-pack). Trimmed, high-passed and
  re-encoded to mono; no other change.

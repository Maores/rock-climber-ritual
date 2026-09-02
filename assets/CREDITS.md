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
  - Attribution is shown in-game on the title screen footer (`src/hud.js`, footHtml()).

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

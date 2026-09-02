# Spider reference material — not shipped, not redistributed

`spiderman_a.glb` and `spiderman_b.glb` are freely downloadable photogrammetry scans of
Spider-Man figures (get3dmodels.com). They were fetched only to sample an authentic palette:
both are single-mesh sculpts with no skeleton, so no geometry from either is used, and neither
file is loaded by the game.

`tex_*.jpg|png` are the textures unpacked from those files, kept for the same reason. The
averages that ended up in `src/spiderHand.js` were #932526 red, #2a3f64 blue, #2a2930 webbing.

The glove in the game is generated in a shader on the climber's own hand model
(`assets/models/hands/realistic_hand.glb`, CC-BY J-Toastie). Spider-Man is Marvel's character
and costume design; this is a personal fan Easter egg locked behind a code, and nothing here
claims otherwise.

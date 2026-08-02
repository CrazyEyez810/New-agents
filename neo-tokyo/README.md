# Neo Tokyo — a rainy Blade Runner block in Three.js

A scene-ready neo-Tokyo city block: wet streets, layered fog, kanji neon,
hologram figures, spinners and heavy rain, rendered in Three.js r166.

Everything is **procedural**. There are no downloaded textures, models or HDRIs —
facades, signage glyphs, billboards and road surfaces are generated at runtime
into canvas textures, and all effects are hand-written shaders. The scene is also
**deterministic**: no `Math.random()` anywhere, and all animation is a pure
function of elapsed time, so a given timestamp always renders the same frame.

## Running it

```bash
npm install
node tools/serve.mjs        # http://127.0.0.1:5173/
```

Without a query string you get orbit controls. Add `?shot=` to jump to one of the
four framed camera presets:

| preset   | framing                                  |
| -------- | ---------------------------------------- |
| `street` | ground level, looking down the corridor  |
| `canyon` | elevated, along the canyon               |
| `aerial` | high wide vista over the rooftops        |
| `alley`  | tight and low, between structures        |

## Rendering stills

```bash
node tools/screenshot.mjs                                  # all 4 presets, 1600x900
node tools/screenshot.mjs street canyon --size 800x450     # faster iteration
node tools/screenshot.mjs --skip weather,signage           # isolate module cost
```

Rendering is headless Chromium on software GL, so a frame legitimately takes
40–100 seconds — slow output is not a hang. Each shot prints objective frame
metrics (luma distribution, saturation, speckle, dominant hue) used to keep the
scene inside a deliberate value structure: roughly 55–75% of pixels in shadow
with a mean luma of 35–60. Darkness is the canvas; light is local and earned.

## Layout

```
src/main.js        camera presets, module wiring, render loop
src/city.js        buildings, facades, window lighting, skyline
src/ground.js      wet asphalt, puddles, planar reflections, kerbs
src/signage.js     neon signs, billboards, hologram figures
src/atmosphere.js  fog, sky, ambient light, volumetric shafts
src/weather.js     rain shells, splashes, steam, mist
src/vehicles.js    spinners, flight paths, traffic streaks
src/postfx.js      bloom, colour grade, grain, vignette
tools/             static server, screenshot harness, glTF export
export/            Blender port — see export/README.md
```

Each module exports one `build*(ctx)` taking `{ scene, camera, renderer }` and
returning `{ group?, update?(t, dt) }`. Modules own their own objects and never
reach into each other, so any one can be rewritten in isolation.

## Blender

`tools/export-gltf.mjs` writes the scene to binary glTF, and
`tools/blender_setup.py` rebuilds what glTF cannot carry — volumetrics, rain,
camera presets, emission strengths. See [`export/README.md`](export/README.md)
for what survives the trip and what gets reconstructed.

## Known gaps

Honest list, from an art-director review against the film:

- **No anti-aliasing** in the post chain — hard edges show staircase artifacts.
- **Rain** is under-differentiated by depth and reads closer to a screen-space
  overlay than to water in the world.
- **Planar reflections** are under-resolved and stair-step on the street.
- Some **facade areas** carry little surface detail where they fall in shadow.
- **Vehicle hulls** lack the material response their hero framing deserves.

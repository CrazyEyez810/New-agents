# Neo Tokyo → Blender

Yes, the scene ports. Not all of it, and the parts that do not port are the
parts that were never geometry in the first place.

This directory holds the export and explains exactly where the line falls.

```
tools/export-gltf.mjs     headless exporter (node + chromium, no GPU needed)
tools/export-scene.mjs    the module it injects into the page
tools/blender_setup.py    run inside Blender AFTER importing the .glb
export/neo-tokyo.glb      the export itself
export/neo-tokyo.manifest.json   machine-readable report of what happened
```

---

## Quick start

```bash
node tools/export-gltf.mjs          # writes export/neo-tokyo.glb
```

Then in Blender:

1. `File > Import > glTF 2.0` → `export/neo-tokyo.glb`
2. `Scripting` workspace → `Open` → `tools/blender_setup.py` → `Run Script`
3. Scrub the timeline to ~frame 100 (the rain needs to reach steady state)
4. Render with `NT_CAM_street` / `NT_CAM_canyon` / `NT_CAM_aerial` / `NT_CAM_alley`

Headless equivalent:

```bash
blender --python-expr "import bpy; bpy.ops.import_scene.gltf(filepath='export/neo-tokyo.glb')" \
        --python tools/blender_setup.py
```

---

## What is in the file

| | |
|---|---|
| Size | **18.60 MB** (19,499,108 bytes) |
| Nodes | 968 (925 carry a mesh) |
| Meshes / primitives | 274 / 274 |
| Materials | 271 |
| Textures / images | 87 / 87 — 15.77 MB of embedded PNG (85% of the file) |
| Triangles | 39,664 unique, 60,962 placed |
| Lights | 2 point lights (signage) |
| `extensionsUsed` | `KHR_texture_transform`, `KHR_materials_emissive_strength`, `KHR_lights_punctual`, `EXT_materials_bump` |
| `extensionsRequired` | **none** — every importer can open this file |

By module:

| Group | Nodes | Triangles | Note |
|---|---|---|---|
| `NT_architecture` | 478 | 39,236 | facades, podiums, megastructure, rooftop clutter, distant skyline |
| `NT_vehicles` | 182 | 13,182 | spinners, ground cars, traffic streaks |
| `NT_ground` | 148 | 5,354 | roadway, sidewalks, kerbs, manholes, grates, clutter |
| `NT_signage` | 117 | 3,190 | kanban, video billboards, holograms, frames, cabling |
| `NT_atmosphere` | 0 | 0 | entirely volumetric — see below |
| `NT_weather` | 0 | 0 | entirely particle/shader — see below |

The empty groups are the whole story of this port in one line: two of the six
modules contain no exportable geometry at all.

---

## Ports cleanly

**Geometry and transforms.** Everything survives, including the merged
`BufferGeometry` batches the city builder produces. The 16 `InstancedMesh`
objects (distant skyline, beacons, roof lights, arcade strips, manholes, grates,
sign halos, traffic streaks) are expanded into 759 ordinary nodes that share one
mesh datablock each — so Blender gets 759 separately selectable objects for the
memory cost of 16 meshes. `EXT_mesh_gpu_instancing` is deliberately *not* used,
because three's exporter also lists it in `extensionsRequired`, which would make
the file unopenable by any importer lacking it.

**PBR material factors and maps.** `MeshStandardMaterial` maps straight onto
glTF metallic-roughness: base colour, metalness, roughness, normal, bump (via
`EXT_materials_bump`), and UV transforms via `KHR_texture_transform` — which
matters here, because the asphalt tiles 8× down the corridor and the ground fill
tiles 55×.

**Procedural canvas textures.** All 87 of them. Every `CanvasTexture` in
`src/` — asphalt with its aggregate and lane paint, sidewalk slabs, facade
albedo *and* window-emissive pairs, podium signage, the neon kanban glyphs, the
video-billboard frames, manhole castings, vent grates, the hologram figure — is
drawn synchronously during the module builds, so by the time the exporter reads
them they are finished bitmaps. They are baked into the file as PNG.

**Emissive.** This is the part most likely to be lost in a naive export, and it
is handled explicitly. The scene expresses "this glows" three different ways and
all three come across:

- `MeshStandardMaterial` + `emissiveMap` (facade windows, podium, megastructure,
  vent grates) → glTF `emissiveTexture` directly.
- `MeshBasicMaterial` with an HDR colour, e.g. neon signs at
  `color.setScalar(4.35)` → the exporter splits that into a unit
  `emissiveFactor` plus `KHR_materials_emissive_strength`, because glTF requires
  `emissiveFactor` to sit in `[0,1]` and clamping would have flattened every
  sign to white. 63 materials carry a strength value; the brightest is **5.34**.
- Per-vertex colour on the vehicle running lights → `COLOR_0`.

**Point lights.** The two signage `PointLight`s export via
`KHR_lights_punctual`. Blender converts the intensity to watts on import; expect
to want a factor-of-N tweak.

---

## Does not port — and what `blender_setup.py` does instead

glTF is a surface format. It describes shapes, transforms, and how light bounces
off a surface. It has no vocabulary for participating media, for screen-space
operations, or for a fragment program. Everything below fell outside that
vocabulary, so the exporter drops it (30 objects) and the Blender script rebuilds
the intent.

### 1. Volumetrics — the big one

`src/atmosphere.js` builds the film look almost entirely out of things that only
exist while a fragment shader is running:

| Dropped | Count | What it was |
|---|---|---|
| `skydome` | 1 | 880-unit `BackSide` sphere with a procedural gradient shader |
| `shaft` | 3 | open cone shells, additive, faking searchlight scatter |
| `inscatter` | 5 | horizontal additive slabs faking the ground fog bed |
| `scrim` | 3 | depth-plane haze cards masked to a soft ellipse |
| `beam` | 10 | vehicle headlight cones, `BackSide` additive |

Plus `scene.fog = FogExp2(#30465a, 0.0118)`, which has no glTF representation at
all. Exporting the carrier geometry would have been actively harmful — a white
opaque cone in the middle of the street is worse than nothing.

**Compensation:** `build_fog_volume()` creates `NT_FogVolume`, a 420×560×260
domain around the block with a **Volume Scatter** shader at the fog colour, and
`build_world()` sets a gradient world background from the same palette.

The density needs a conversion. Three's `FogExp2` is `exp(-(d·density)²)`; a
Cycles volume is Beer-Lambert `exp(-d·σ)`. They cannot agree at every depth, so
the script matches them at the far wall of the corridor:

```
exp(-(100 · 0.0118)²) = 0.2485   →   σ = -ln(0.2485)/100 = 0.0139
```

which is `FOG_SCATTER_DENSITY` at the top of the script.

This one object subsumes *four* of the hand-built systems above. Because a real
volume scatters every emissive in the scene, the searchlight shafts, the ground
inscatter bed and the neon haloes all fall out of it for free — they existed in
the Three.js version only because a rasteriser cannot do this.

### 2. Rain, splashes, steam

`src/weather.js` runs 9,600 rain quads across three shells, 320 splash crowns
and 85 steam puffs. All of them are a single unit quad in an
`InstancedBufferGeometry`, with every particle's position computed in a vertex
shader from `uTime` and a per-instance seed. There is no geometry to export —
literally two triangles per system — so the exporter drops all 5 particle meshes
plus the 2 probe-lit haze sheets.

**Compensation:** `build_rain()` builds a real particle system —
`NT_RainEmitter`, 120,000 particles (~42,000 alive at steady state) instancing
`NT_RainDrop`, a thin prism whose long axis is **baked into the vertex data**
along the storm direction. Baking beats setting `rotation_mode = 'VEL'`, whose
axis convention has shifted between Blender releases.

Initial velocity is `(7.4, -2.3, -26.0)`, taken from the shader's wind vector and
fall speed, with gravity dialled to 0.15 because real rain is at terminal
velocity, not accelerating. Lifetime (70 frames) is set to just outrun the fall
time from the emitter (62 / 26 = 57 frames), which is what produces a steady
column instead of one cohort sinking past the street.

Note the emitter is world-space and cannot chase the camera the way the Three.js
shells do, so it covers the corridor and the count is sized for the volume.

Splashes and steam are **not** rebuilt. Steam in particular wants a Blender
smoke sim, which is a project rather than a script.

### 3. Post-processing

`src/postfx.js` is a screen-space chain over a render target — bloom, chromatic
aberration, grain, vignette. It is not scene content and is not exported at all
(the export skips the module entirely).

**Compensation:** `configure_compositor()` wires a **Glare (Fog Glow)** node
between Render Layers and Composite. `configure_render()` sets the view
transform to **AgX** (falling back to Filmic, then Standard) as the closest thing
Blender ships to the scene's `ACESFilmicToneMapping` at exposure 1.02, and turns
`film_transparent` **off** — a transparent film would punch a hole straight
through the fog volume that the whole look depends on.

### 4. Custom `ShaderMaterial` surfaces

Two ShaderMaterials describe actual surfaces rather than volumes, so they are
converted rather than dropped:

- **Holograms** (4 planes). The geometry and the figure canvas port fine as an
  emissive plane. What does not port is the shader: scanline breakup, the
  vertical flicker sweep, the offset ghost layer, per-frame phase. You get a
  clean glowing figure; you do not get the projection artefacts.
- **Spinner hull and canopy** (22 meshes). A bespoke wet-lacquer model with rim,
  gloss, sheen and panel terms, all view-dependent. Converted to a Principled
  surface at metalness 0.9 / roughness 0.18 (0.4 / 0.08 for glass) — which is
  what the shader was imitating, and Cycles derives it properly from the real
  environment.

### 5. Additive blending

266 materials in this scene use `AdditiveBlending` — every neon kanban, halo,
spill card, kerb sheen, lens, ground glow pool and traffic streak. glTF only has
`OPAQUE`/`MASK`/`BLEND`, so the exporter writes them as `BLEND` with a black
base colour and the image in the emissive slot.

**Compensation:** `make_additive()` rebuilds those node trees as
**Add Shader(Transparent BSDF, Emission)**, which is *exactly* additive in
Cycles: the transparent closure passes the background through unchanged and the
emission adds on top. Alpha is routed to Emission **Strength**, not to a mix
factor, because three's `AdditiveBlending` is `blendFunc(SRC_ALPHA, ONE)` —
alpha scales the contribution, it does not cut holes. As a side effect these
cards stop casting rectangular shadows.

### 6. Code-driven animation

Every moving thing in this scene is a pure function of `t` evaluated in JS or
GLSL each frame: vehicle flight paths, sign flicker, billboard playback,
searchlight sweep, haze drift. None of it is a keyframe track or a skinned
animation, so there is nothing for glTF's animation channels to hold.

**The export is one frozen frame** — `t = 12s`, the same time the screenshot
harness uses. Change it with `--t`.

No compensation is attempted. Re-animating in Blender means rebuilding the
motion with drivers or F-curves, and the source of truth for the maths is
`src/vehicles.js` and `src/signage.js`.

### 7. Odds and ends

- **`HemisphereLight` + `AmbientLight`** — `KHR_lights_punctual` covers only
  directional/point/spot. Removed at export; the world shader carries the whole
  ambient term instead.
- **`Reflector`** (the wet-street planar mirror) — a live render target. Dropped;
  Cycles does reflections properly from the roughness map.
- **`onBeforeCompile` injections** — the city's procedural concrete detail and
  sheen programs are patched into `MeshStandardMaterial` at compile time. The
  base maps and factors export; the injected GLSL does not.
- **`lightMap` / `lightMapIntensity`** on the roadway and sidewalk — glTF has no
  lightmap slot. Lost. The baked neon spill on the tarmac has to come from real
  emissive geometry in Blender, which it now does.

---

## Exporter reference

```
node tools/export-gltf.mjs [options]

  --out PATH          output .glb                  (default export/neo-tokyo.glb)
  --shot KEY          SHOTS preset for the camera  (default street)
  --t SECONDS         scene time to freeze at      (default 12)
  --frames N          update ticks before export   (default 90)
  --render-frames N   how many also do a GL render (default 0)
  --max-texture N     clamp image dimension        (default 2048)
  --keep-fx           keep the volumetric/particle carrier geometry
  --timeout SECONDS   page budget                  (default 600)
  --manifest PATH     JSON report
```

`--keep-fx` exports the dropped carriers as generic emissive surfaces instead
(+30 objects, +4.5k triangles, 19.04 MB). Useful for seeing *where* the effects
sat before rebuilding them; not useful for rendering.

`--max-texture 1024` roughly halves the file, since 85% of it is PNG.

### How it gets the scene

`src/main.js` does not publish the scene on `window`, and this tooling does not
modify it. So the exporter loads the page, probes for a usable global, finds
none, and injects `tools/export-scene.mjs` as a module script. That module
imports the same `/src/*.js` URLs `main.js` does — the ES module registry hands
back the identical instances, so there is no forked copy of the scene code and
the mulberry32 seeds produce the identical city.

The reload before injection passes `skip=` for every module, so `main.js`
supplies the document and its importmap but builds nothing; the scene is
constructed exactly once.

The GLB comes back out of the browser as base64 via `FileReader`, drained in
4-byte-aligned chunks through `page.evaluate` and written with `fs`.

### Reproducibility

Structurally deterministic: every run yields the same 968 nodes, 274 meshes, 271
materials, 87 textures and 39,664 triangles. It is *not* byte-identical, because
`GLTFExporter` appends encoded PNGs to the binary chunk in `toBlob` completion
order, which shuffles buffer-view offsets between runs. The glTF is equally valid
either way; file sizes across runs differed by 4 bytes of chunk padding.

### Known warnings

`THREE.GLTFExporter: Merged metalnessMap and roughnessMap textures.` — expected
and correct. The roadway supplies a roughness map with no metalness map, so the
exporter packs it into a combined ORM texture, which is what glTF requires.

No page console errors are produced by a clean run; the exporter exits non-zero
if any appear, or if the output falls below 256 KB.

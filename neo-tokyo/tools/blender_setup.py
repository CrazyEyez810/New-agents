"""
Neo Tokyo — post-import Blender setup.

Run this AFTER importing export/neo-tokyo.glb (File > Import > glTF 2.0).

    Blender GUI : Scripting workspace > Open > tools/blender_setup.py > Run Script
    Headless    : blender scene.blend --python tools/blender_setup.py

What it does, and why any of it is necessary:

glTF is a surface-and-transform format. It carries meshes, hierarchies, PBR
factors and image maps very well, and it carries nothing at all about how a
scene was lit volumetrically, what its post chain did, or what its shaders were
computing per fragment. tools/export-gltf.mjs therefore drops the parts of the
Three.js scene that only existed as fragment programs, and this script rebuilds
the *intent* of each one with a Blender-native equivalent:

    Three.js                          ->  Blender
    ------------------------------------  ------------------------------------
    scene.fog = FogExp2(#30465a, .0118)   Volume Scatter domain + world colour
    3 additive cone-shell light shafts    (falls out of the volume + emissives)
    5 additive ground inscatter slabs     (same)
    3 depth-plane haze scrims             (same)
    procedural sky-dome ShaderMaterial    world background gradient
    9600 instanced GPU rain quads         particle system with a streak instance
    additive neon / halo / billboard      Transparent + Emission via Add Shader
    ACESFilmic tonemap @ exposure 1.02    AgX (or Filmic) view transform
    postfx bloom chain                    compositor Glare (Fog Glow)
    SHOTS camera presets                  four named cameras, matching vertical fov

Everything it creates is prefixed NT_ and lives in the "NT_Setup" collection, so
re-running the script replaces its own work and never touches imported geometry
beyond the documented material fixups.

Blender 3.0+ (tested API surface is 3.x / 4.x compatible; every version-specific
call is guarded).
"""

import math

import bpy
from mathutils import Vector

# ---------------------------------------------------------------------------
# CONFIG — the numbers below are lifted from src/. If src/ changes, change here.
# ---------------------------------------------------------------------------

# src/atmosphere.js: FOG_COLOR / FOG_DENSITY
FOG_COLOR_HEX = 0x30465A
FOG_DENSITY_THREE = 0.0118

# FogExp2 is exp(-(d * density)^2); a Cycles volume is Beer-Lambert exp(-d * s).
# They cannot match at every depth, so match at the depth that matters — the far
# wall of the corridor, ~100 units out:
#     exp(-(100 * 0.0118)^2) = 0.2485  ->  s = -ln(0.2485) / 100 = 0.0139
# Lower this for a clearer deep field, raise it for a soupier one.
FOG_SCATTER_DENSITY = 0.0139
FOG_ANISOTROPY = 0.30           # forward scatter — haloes the neon, as wet air does

# src/atmosphere.js: HemisphereLight(0x3c4d5c, 0x1d150c, 0.84) + AmbientLight.
# Neither survives glTF (KHR_lights_punctual is directional/point/spot only), so
# the world carries the whole ambient term.
SKY_ZENITH_HEX = 0x030508
SKY_HORIZON_HEX = 0x48697F      # FOG_COLOR * 1.5, per makeSkyDome()
SKY_GROUND_HEX = 0x1D150C
WORLD_STRENGTH = 0.35

# src/weather.js: RAIN_SHELLS wind (7.4, 2.3), fall speed ~26 u/s.
#
# The Three.js version parks three camera-following boxes of instanced quads
# around the lens, so a small drop count reads as a downpour. A Blender particle
# system is world-space and cannot follow the camera, so the emitter covers the
# corridor and the count is sized for the volume instead.
#
#   emitter 80 x 200 units at height 62 -> ~1.0e6 cubic units
#   fall time 62 / 26 = 2.4 s = 57 frames at 24 fps -> lifetime 70
#   alive at steady state = COUNT * lifetime / (frame_end - frame_start)
RAIN_COUNT = 120000
RAIN_LIFETIME = 70.0
RAIN_EMIT_UNTIL = 200.0
RAIN_AREA = (80.0, 200.0)       # blender x, y extents of the emitter
RAIN_HEIGHT = 62.0              # three-space y the drops start from
RAIN_WIND = (7.4, 2.3)          # three-space x, z
RAIN_FALL_SPEED = 26.0
RAIN_DROP_LENGTH = 0.45
RAIN_DROP_RADIUS = 0.011
RAIN_EMISSION = (0.42, 0.58, 0.78)
RAIN_EMISSION_STRENGTH = 1.6

# Emission trim. The exporter already folded every HDR colour into
# KHR_materials_emissive_strength, so these are taste multipliers on top.
ADDITIVE_BOOST = 1.0            # neon kanban, halos, billboards, holograms
WINDOW_BOOST = 2.0              # facade / podium / megastructure emissive maps
UNLIT_BOOST = 1.0               # opaque MeshBasicMaterial surfaces

# src/main.js: SHOTS. pos / look are three-space; fov is VERTICAL degrees.
SHOTS = {
    "street": {"pos": (8, 3.2, 34), "look": (0, 14, -30), "fov": 42},
    "canyon": {"pos": (-14, 22, 46), "look": (4, 26, -60), "fov": 48},
    "aerial": {"pos": (-40, 78, 70), "look": (10, 20, -40), "fov": 50},
    "alley": {"pos": (-6, 2.2, 12), "look": (8, 10, -40), "fov": 55},
}
DEFAULT_SHOT = "street"

RESOLUTION = (1600, 900)        # matches tools/screenshot.mjs --size
CYCLES_SAMPLES = 256

SETUP_COLLECTION = "NT_Setup"
PREFIX = "NT_"

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def srgb_to_linear(c):
    """Blender node colours are linear; the src/ constants are sRGB hex."""
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_to_linear(value, alpha=1.0):
    r = ((value >> 16) & 0xFF) / 255.0
    g = ((value >> 8) & 0xFF) / 255.0
    b = (value & 0xFF) / 255.0
    return (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b), alpha)


def v3(x, y, z):
    """Three.js (Y-up, -Z forward) -> Blender (Z-up), the same mapping the glTF
    importer applies to the imported geometry."""
    return Vector((x, -z, y))


def get_collection():
    col = bpy.data.collections.get(SETUP_COLLECTION)
    if col is None:
        col = bpy.data.collections.new(SETUP_COLLECTION)
        bpy.context.scene.collection.children.link(col)
    return col


def purge_previous():
    """Idempotency: remove everything a previous run of this script created."""
    for obj in [o for o in bpy.data.objects if o.name.startswith(PREFIX)]:
        bpy.data.objects.remove(obj, do_unlink=True)
    for block in (bpy.data.meshes, bpy.data.cameras, bpy.data.particles):
        for item in [b for b in block if b.name.startswith(PREFIX)]:
            if item.users == 0:
                block.remove(item)
    for mat in [m for m in bpy.data.materials if m.name.startswith(PREFIX + "SETUP_")]:
        bpy.data.materials.remove(mat)


def new_object(name, mesh):
    obj = bpy.data.objects.new(name, mesh)
    get_collection().objects.link(obj)
    return obj


def box_mesh(name, sx, sy, sz):
    """Outward-facing box, built at its real size without bpy.ops.

    Meshes here are built full-size and objects left at scale 1 on purpose:
    a particle system's `object_align_factor` is applied along the emitter's
    object axes, and a scaled object makes that velocity ambiguous."""
    hx, hy, hz = sx * 0.5, sy * 0.5, sz * 0.5
    mesh = bpy.data.meshes.new(name)
    v = [
        (-hx, -hy, -hz), (hx, -hy, -hz), (hx, hy, -hz), (-hx, hy, -hz),
        (-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz),
    ]
    f = [
        (0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
        (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7),
    ]
    mesh.from_pydata(v, [], f)
    mesh.validate()
    mesh.update()
    return mesh


def plane_mesh(name, sx, sy):
    hx, hy = sx * 0.5, sy * 0.5
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(
        [(-hx, -hy, 0.0), (hx, -hy, 0.0), (hx, hy, 0.0), (-hx, hy, 0.0)],
        [],
        [(0, 1, 2, 3)],
    )
    mesh.validate()
    mesh.update()
    return mesh


def streak_mesh(name, radius, length, direction, segments=6):
    """A thin prism whose long axis is baked into the vertex data along
    `direction`. Baking the orientation into the mesh (instead of relying on the
    particle system's rotation modes, whose axis conventions differ between
    releases) guarantees every drop leans the right way."""
    quat = Vector(direction).normalized().to_track_quat("Z", "Y")
    verts = []
    for i in range(segments):
        a = 2.0 * math.pi * i / segments
        x, y = radius * math.cos(a), radius * math.sin(a)
        verts.append(quat @ Vector((x, y, -length * 0.5)))
        verts.append(quat @ Vector((x, y, length * 0.5)))
    faces = []
    for i in range(segments):
        a0 = 2 * i
        b0 = 2 * ((i + 1) % segments)
        faces.append((a0, a0 + 1, b0 + 1, b0))
    faces.append(tuple(2 * i for i in range(segments - 1, -1, -1)))
    faces.append(tuple(2 * i + 1 for i in range(segments)))

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(v) for v in verts], [], faces)
    mesh.validate()
    mesh.update()
    return mesh


def node(tree, idname, x=0, y=0):
    n = tree.nodes.new(idname)
    n.location = (x, y)
    return n


def find_node(tree, node_type):
    for n in tree.nodes:
        if n.type == node_type:
            return n
    return None


def find_input(shader_node, names):
    """Principled BSDF socket names moved between releases ('Emission' became
    'Emission Color' in 4.0). Take the first name that exists."""
    for name in names:
        if name in shader_node.inputs:
            return shader_node.inputs[name]
    return None


def safe_set(obj, attr, value):
    """Set an attribute if this Blender build has it. Used for the handful of
    properties that were added or removed across 3.x / 4.x."""
    try:
        if hasattr(obj, attr):
            setattr(obj, attr, value)
            return True
    except (TypeError, ValueError, AttributeError):
        pass
    return False


def set_enum(obj, attr, candidates):
    """Assign the first enum value this build accepts."""
    for value in candidates:
        try:
            setattr(obj, attr, value)
            return value
        except (TypeError, ValueError, AttributeError):
            continue
    return None


# ---------------------------------------------------------------------------
# 1. WORLD — replaces the sky-dome ShaderMaterial and the hemisphere/ambient
#    lights, neither of which glTF can carry.
# ---------------------------------------------------------------------------


def build_world():
    world = bpy.data.worlds.get("NT_World") or bpy.data.worlds.new("NT_World")
    bpy.context.scene.world = world
    world.use_nodes = True
    tree = world.node_tree
    tree.nodes.clear()

    out = node(tree, "ShaderNodeOutputWorld", 400, 0)
    bg = node(tree, "ShaderNodeBackground", 200, 0)
    bg.inputs["Strength"].default_value = WORLD_STRENGTH

    # Vertical gradient: near-black zenith falling to the fog colour at the
    # horizon, which is what makes silhouettes melt into the haze.
    coord = node(tree, "ShaderNodeTexCoord", -600, 0)
    sep = node(tree, "ShaderNodeSeparateXYZ", -420, 0)
    remap = node(tree, "ShaderNodeMath", -260, 0)          # z in [-1,1] -> [0,1]
    ramp = node(tree, "ShaderNodeValToRGB", -80, 0)

    tree.links.new(coord.outputs["Generated"], sep.inputs["Vector"])
    if set_enum(remap, "operation", ["MULTIPLY_ADD"]):
        remap.inputs[1].default_value = 0.5
        remap.inputs[2].default_value = 0.5
        tree.links.new(sep.outputs["Z"], remap.inputs[0])
        tree.links.new(remap.outputs["Value"], ramp.inputs["Fac"])
    else:
        # Very old build without MULTIPLY_ADD: feed Z straight in. Everything
        # below the horizon clamps to the first stop, which is the fog colour.
        tree.links.new(sep.outputs["Z"], ramp.inputs["Fac"])

    elements = ramp.color_ramp.elements
    elements[0].position = 0.0
    elements[0].color = hex_to_linear(SKY_GROUND_HEX)
    elements[1].position = 0.52
    elements[1].color = hex_to_linear(SKY_HORIZON_HEX)
    mid = elements.new(0.72)
    mid.color = hex_to_linear(FOG_COLOR_HEX)
    top = elements.new(1.0)
    top.color = hex_to_linear(SKY_ZENITH_HEX)

    tree.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    tree.links.new(bg.outputs["Background"], out.inputs["Surface"])
    return world


# ---------------------------------------------------------------------------
# 2. VOLUMETRIC FOG — the single biggest thing glTF loses.
#
# A Volume Scatter domain around the whole block. Because it scatters the world
# background and every neon emissive in the scene, it recreates in one object
# what src/atmosphere.js had to fake with three separate systems: aerial
# perspective (FogExp2), the searchlight shafts, and the ground inscatter bed.
# ---------------------------------------------------------------------------


def build_fog_volume():
    # Corridor runs three-z -230..+50 with buildings to y ~130; pad generously
    # so no camera preset ever sits outside the domain. A camera outside the
    # volume sees the fog as a solid slab in front of it instead of being in it.
    mesh = box_mesh(PREFIX + "FogVolume_mesh", 420.0, 560.0, 260.0)
    obj = new_object(PREFIX + "FogVolume", mesh)
    obj.location = v3(0.0, 90.0, -90.0)
    obj.display_type = "WIRE"
    obj.show_in_front = False
    safe_set(obj, "visible_shadow", False)
    safe_set(obj, "visible_diffuse", False)
    safe_set(obj, "visible_glossy", False)

    mat = bpy.data.materials.new(PREFIX + "SETUP_Fog")
    mat.use_nodes = True
    tree = mat.node_tree
    tree.nodes.clear()

    out = node(tree, "ShaderNodeOutputMaterial", 300, 0)
    scatter = node(tree, "ShaderNodeVolumeScatter", 0, 0)
    scatter.inputs["Color"].default_value = hex_to_linear(FOG_COLOR_HEX)
    scatter.inputs["Density"].default_value = FOG_SCATTER_DENSITY
    scatter.inputs["Anisotropy"].default_value = FOG_ANISOTROPY
    tree.links.new(scatter.outputs["Volume"], out.inputs["Volume"])

    # Surface deliberately left unconnected: the domain must be invisible to
    # camera rays and act only as a volume boundary.
    obj.data.materials.append(mat)
    return obj


# ---------------------------------------------------------------------------
# 3. RAIN — src/weather.js runs three shells of instanced GPU quads whose motion
#    lives entirely in a vertex shader. None of that is expressible in glTF, so
#    the geometry was dropped at export and rebuilt here as a real particle
#    system that Cycles can motion-blur and light.
# ---------------------------------------------------------------------------


def build_rain():
    # Falling direction in Blender space: wind across x/y, gravity down z.
    direction = Vector((RAIN_WIND[0], -RAIN_WIND[1], -RAIN_FALL_SPEED))

    drop_mesh = streak_mesh(
        PREFIX + "RainDrop_mesh", RAIN_DROP_RADIUS, RAIN_DROP_LENGTH, direction
    )
    drop = new_object(PREFIX + "RainDrop", drop_mesh)
    # Parked far below the block. A particle instance source still renders at
    # its own location, and this is cheaper and more predictable than relying on
    # visibility flags that behave differently per release.
    drop.location = (0.0, 0.0, -800.0)

    drop_mat = bpy.data.materials.new(PREFIX + "SETUP_RainDrop")
    drop_mat.use_nodes = True
    tree = drop_mat.node_tree
    tree.nodes.clear()
    out = node(tree, "ShaderNodeOutputMaterial", 300, 0)
    add = node(tree, "ShaderNodeAddShader", 120, 0)
    transparent = node(tree, "ShaderNodeBsdfTransparent", -80, 120)
    emission = node(tree, "ShaderNodeEmission", -80, -60)
    emission.inputs["Color"].default_value = (*RAIN_EMISSION, 1.0)
    emission.inputs["Strength"].default_value = RAIN_EMISSION_STRENGTH
    tree.links.new(transparent.outputs["BSDF"], add.inputs[0])
    tree.links.new(emission.outputs["Emission"], add.inputs[1])
    tree.links.new(add.outputs["Shader"], out.inputs["Surface"])
    # For physically-lit rain instead of self-lit streaks, swap the Emission for
    # a Glass BSDF (IOR 1.33) — slower and noisier, but the neon then genuinely
    # refracts through the drops.
    drop.data.materials.append(drop_mat)

    emitter_mesh = plane_mesh(PREFIX + "RainEmitter_mesh", *RAIN_AREA)
    emitter = new_object(PREFIX + "RainEmitter", emitter_mesh)
    emitter.location = v3(0.0, RAIN_HEIGHT, -70.0)
    emitter.display_type = "WIRE"
    safe_set(emitter, "visible_camera", False)
    safe_set(emitter, "visible_shadow", False)
    emitter.hide_render = False   # the emitter itself is hidden by show_instancer_for_render

    modifier = emitter.modifiers.new(PREFIX + "Rain", type="PARTICLE_SYSTEM")
    psys = modifier.particle_system
    psys.name = PREFIX + "Rain"
    settings = psys.settings
    settings.name = PREFIX + "RainSettings"

    settings.type = "EMITTER"
    settings.count = RAIN_COUNT
    # Continuous emission with a lifetime just longer than the fall time gives a
    # steady-state column rather than one cohort of drops sinking past the
    # street. The point cache starts at the scene's first frame, so emission
    # cannot begin before frame 1 — hence the "scrub forward" note at the end.
    settings.frame_start = 1.0
    settings.frame_end = RAIN_EMIT_UNTIL
    settings.lifetime = RAIN_LIFETIME
    settings.lifetime_random = 0.15
    settings.emit_from = "FACE"
    set_enum(settings, "distribution", ["RAND"])
    settings.physics_type = "NEWTON"
    settings.mass = 0.02
    settings.normal_factor = 0.0
    # Initial velocity carries the whole storm: gravity is turned most of the
    # way down because real rain is at terminal velocity, not accelerating.
    settings.object_align_factor = (direction.x, direction.y, direction.z)
    settings.factor_random = 2.5
    settings.effector_weights.gravity = 0.15
    settings.use_rotations = False          # orientation is baked into the mesh
    settings.particle_size = 1.0
    settings.size_random = 0.6
    settings.render_type = "OBJECT"
    settings.instance_object = drop
    safe_set(settings, "use_scale_instance", True)
    safe_set(emitter, "show_instancer_for_render", False)
    safe_set(emitter, "show_instancer_for_viewport", False)

    return emitter, drop


# ---------------------------------------------------------------------------
# 4. MATERIAL FIXUPS.
#
# tools/export-gltf.mjs names every material NT_<KIND>_<n> and stamps the same
# kind into glTF material extras, which Blender imports as a custom property.
# Name is the primary key here because it survives every importer setting.
#
#   NT_ADDITIVE_ / NT_HOLO_  three used AdditiveBlending: dst + src. Alpha
#                            blending cannot express that, so the node tree is
#                            rebuilt as Add Shader(Transparent, Emission), which
#                            IS additive in Cycles — and, as a bonus, casts no
#                            shadow and never shows a card edge.
#   NT_EMISSIVE_             standard materials with an emissive map (facade
#                            windows, podium signage, vent grates). Emission
#                            strength only.
#   NT_UNLIT_ / NT_VCOL_     opaque MeshBasicMaterial surfaces. Vertex-coloured
#                            ones get their COLOR_0 attribute wired to emission.
#   NT_WET_ / NT_PBR_        already correct as Principled; left alone.
# ---------------------------------------------------------------------------


def _image_from_tree(tree):
    """Prefer the texture feeding emission; fall back to the base-colour one.
    The exporter puts the same image in both slots for emissive materials."""
    principled = find_node(tree, "BSDF_PRINCIPLED")
    if principled is not None:
        emit = find_input(principled, ("Emission Color", "Emission"))
        for socket in (emit, principled.inputs.get("Base Color")):
            if socket is None or not socket.is_linked:
                continue
            src = socket.links[0].from_node
            if src.type == "TEX_IMAGE" and src.image is not None:
                return src.image
    for n in tree.nodes:
        if n.type == "TEX_IMAGE" and n.image is not None:
            return n.image
    return None


def _emission_state(tree):
    """Read the colour/strength the glTF importer produced, before we clear it."""
    color = (1.0, 1.0, 1.0, 1.0)
    strength = 1.0
    principled = find_node(tree, "BSDF_PRINCIPLED")
    if principled is not None:
        emit = find_input(principled, ("Emission Color", "Emission"))
        if emit is not None and not emit.is_linked:
            color = tuple(emit.default_value)
        power = principled.inputs.get("Emission Strength")
        if power is not None and not power.is_linked:
            strength = float(power.default_value)
    return color, strength


def make_additive(mat, boost):
    tree = mat.node_tree
    if tree is None:
        return False
    image = _image_from_tree(tree)
    color, strength = _emission_state(tree)
    strength = max(strength, 1e-4) * boost

    out = find_node(tree, "OUTPUT_MATERIAL")
    for n in list(tree.nodes):
        if n is not out:
            tree.nodes.remove(n)
    if out is None:
        out = node(tree, "ShaderNodeOutputMaterial", 500, 0)
    out.location = (520, 0)

    add = node(tree, "ShaderNodeAddShader", 320, 0)
    transparent = node(tree, "ShaderNodeBsdfTransparent", 140, 140)
    emission = node(tree, "ShaderNodeEmission", 140, -80)
    emission.inputs["Color"].default_value = color
    emission.inputs["Strength"].default_value = strength

    if image is not None:
        tex = node(tree, "ShaderNodeTexImage", -420, -40)
        tex.image = image
        set_enum(tex.image.colorspace_settings, "name", ["sRGB"])

        # Emission colour = texture * emissiveFactor. VectorMath is used instead
        # of MixRGB because its identifier and sockets are stable across 3.x/4.x.
        tint = node(tree, "ShaderNodeVectorMath", -160, 40)
        set_enum(tint, "operation", ["MULTIPLY"])
        tint.inputs[1].default_value = (color[0], color[1], color[2])
        tree.links.new(tex.outputs["Color"], tint.inputs[0])
        tree.links.new(tint.outputs["Vector"], emission.inputs["Color"])

        # Three's AdditiveBlending is blendFunc(SRC_ALPHA, ONE): the contribution
        # is scaled by alpha, so alpha modulates STRENGTH, it does not cut holes.
        gain = node(tree, "ShaderNodeMath", -160, -200)
        set_enum(gain, "operation", ["MULTIPLY"])
        gain.inputs[1].default_value = strength
        tree.links.new(tex.outputs["Alpha"], gain.inputs[0])
        tree.links.new(gain.outputs["Value"], emission.inputs["Strength"])

    tree.links.new(transparent.outputs["BSDF"], add.inputs[0])
    tree.links.new(emission.outputs["Emission"], add.inputs[1])
    tree.links.new(add.outputs["Shader"], out.inputs["Surface"])

    # EEVEE hints. Cycles needs none of this; both properties moved in 4.2, so
    # every one of them is optional.
    set_enum(mat, "blend_method", ["BLEND"])
    set_enum(mat, "shadow_method", ["NONE"])
    set_enum(mat, "surface_render_method", ["BLENDED"])
    safe_set(mat, "use_backface_culling", False)
    return True


def scale_emission(mat, boost):
    tree = mat.node_tree
    if tree is None:
        return False
    principled = find_node(tree, "BSDF_PRINCIPLED")
    if principled is None:
        return False
    power = principled.inputs.get("Emission Strength")
    if power is None or power.is_linked:
        return False
    if power.default_value <= 0.0:
        # Some importers leave strength at 0 with a non-black emissive factor.
        emit = find_input(principled, ("Emission Color", "Emission"))
        if emit is None or (not emit.is_linked and max(emit.default_value[:3]) <= 0.0):
            return False
        power.default_value = 1.0
    power.default_value *= boost
    return True


def wire_vertex_colors(mat):
    """COLOR_0 carries the vehicle running-light colours. Wire it into emission
    so the tail-lights are red and the strobes are not white."""
    tree = mat.node_tree
    if tree is None:
        return False
    principled = find_node(tree, "BSDF_PRINCIPLED")
    if principled is None:
        return False
    emit = find_input(principled, ("Emission Color", "Emission"))
    if emit is None or emit.is_linked:
        return False

    layer = "Color"
    for obj in bpy.data.objects:
        if obj.type != "MESH" or mat.name not in [m.name for m in obj.data.materials if m]:
            continue
        attrs = getattr(obj.data, "color_attributes", None)
        if attrs:
            layer = attrs[0].name
            break

    attr = node(tree, "ShaderNodeAttribute", -320, -120)
    set_enum(attr, "attribute_type", ["GEOMETRY"])
    attr.attribute_name = layer
    tree.links.new(attr.outputs["Color"], emit)
    return True


def fix_materials():
    counts = {"additive": 0, "holo": 0, "emissive": 0, "unlit": 0, "vcol": 0, "skipped": 0}
    for mat in bpy.data.materials:
        name = mat.name
        if not name.startswith("NT_") or not mat.use_nodes:
            continue
        if name.startswith("NT_ADDITIVE"):
            counts["additive"] += make_additive(mat, ADDITIVE_BOOST)
        elif name.startswith("NT_HOLO"):
            counts["holo"] += make_additive(mat, ADDITIVE_BOOST)
        elif name.startswith("NT_EMISSIVE"):
            counts["emissive"] += scale_emission(mat, WINDOW_BOOST)
        elif name.startswith("NT_VCOL"):
            wire_vertex_colors(mat)
            counts["vcol"] += scale_emission(mat, UNLIT_BOOST)
        elif name.startswith("NT_UNLIT"):
            counts["unlit"] += scale_emission(mat, UNLIT_BOOST)
        else:
            counts["skipped"] += 1
    return counts


# ---------------------------------------------------------------------------
# 5. CAMERAS — the four SHOTS presets from src/main.js.
#
# three.js and Blender share the camera convention (look down -Z, +Y up), so the
# only work is converting the position/target into Blender's Z-up space and
# telling Blender that `fov` is VERTICAL.
# ---------------------------------------------------------------------------


def build_cameras():
    made = []
    for key, shot in SHOTS.items():
        data = bpy.data.cameras.new(PREFIX + "CAM_" + key)
        data.sensor_fit = "VERTICAL"
        data.sensor_height = 24.0
        data.lens_unit = "FOV"
        data.angle_y = math.radians(shot["fov"])
        data.clip_start = 0.1
        data.clip_end = 2000.0

        obj = new_object(PREFIX + "CAM_" + key, data)
        eye = v3(*shot["pos"])
        target = v3(*shot["look"])
        obj.location = eye
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = (target - eye).to_track_quat("-Z", "Y")
        made.append(obj)

        if key == DEFAULT_SHOT:
            bpy.context.scene.camera = obj
    return made


# ---------------------------------------------------------------------------
# 6. RENDER CONFIG.
# ---------------------------------------------------------------------------


def configure_render():
    scene = bpy.context.scene
    render = scene.render

    render.engine = "CYCLES"
    render.resolution_x, render.resolution_y = RESOLUTION
    render.resolution_percentage = 100

    # Explicitly OFF: the fog volume and the sky gradient are the background.
    # A transparent film would punch a hole straight through the atmosphere.
    render.film_transparent = False

    cycles = getattr(scene, "cycles", None)
    if cycles is not None:
        safe_set(cycles, "samples", CYCLES_SAMPLES)
        safe_set(cycles, "preview_samples", 32)
        safe_set(cycles, "use_denoising", True)
        safe_set(cycles, "use_preview_denoising", True)
        safe_set(cycles, "max_bounces", 8)
        safe_set(cycles, "diffuse_bounces", 3)
        safe_set(cycles, "glossy_bounces", 4)
        safe_set(cycles, "transmission_bounces", 8)
        # The scene is a stack of alpha-blended neon and halo cards; the default
        # of 8 transparent bounces turns overlapping signage into black patches.
        safe_set(cycles, "transparent_max_bounces", 64)
        safe_set(cycles, "volume_bounces", 2)
        safe_set(cycles, "volume_step_rate", 1.0)
        safe_set(cycles, "volume_preview_step_rate", 2.0)
        safe_set(cycles, "volume_max_steps", 1024)
        safe_set(cycles, "caustics_reflective", False)
        safe_set(cycles, "caustics_refractive", False)

    # src/main.js renders with ACESFilmicToneMapping at exposure 1.02. AgX is
    # the closest thing Blender ships; Filmic is the pre-4.0 fallback.
    view = scene.view_settings
    transform = set_enum(view, "view_transform", ["AgX", "Filmic", "Standard"])
    if transform == "AgX":
        set_enum(view, "look", ["AgX - Medium High Contrast", "Medium High Contrast", "None"])
    elif transform == "Filmic":
        set_enum(view, "look", ["Filmic - Medium High Contrast", "Medium High Contrast", "None"])
    safe_set(view, "exposure", 0.0)
    safe_set(view, "gamma", 1.0)

    scene.frame_start = 1
    scene.frame_end = 250
    return transform


def configure_compositor():
    """src/postfx.js runs a bloom/glare chain over the rendered frame. Cycles has
    no post chain, so the equivalent goes in the compositor."""
    scene = bpy.context.scene
    scene.use_nodes = True
    tree = scene.node_tree
    tree.nodes.clear()

    layers = node(tree, "CompositorNodeRLayers", -300, 0)
    glare = node(tree, "CompositorNodeGlare", 0, 0)
    composite = node(tree, "CompositorNodeComposite", 320, 60)
    viewer = node(tree, "CompositorNodeViewer", 320, -140)

    set_enum(glare, "glare_type", ["FOG_GLOW"])
    set_enum(glare, "quality", ["HIGH", "MEDIUM"])
    safe_set(glare, "mix", -0.15)      # mostly original, a wash of glow on top
    safe_set(glare, "threshold", 0.8)
    safe_set(glare, "size", 8)

    tree.links.new(layers.outputs["Image"], glare.inputs["Image"])
    tree.links.new(glare.outputs["Image"], composite.inputs["Image"])
    tree.links.new(glare.outputs["Image"], viewer.inputs["Image"])


# ---------------------------------------------------------------------------


def main():
    print("")
    print("=" * 70)
    print("Neo Tokyo — Blender setup")
    print("=" * 70)

    imported = [o for o in bpy.data.objects if not o.name.startswith(PREFIX)]
    if not imported:
        print("WARNING: no non-NT_ objects found.")
        print("         Import export/neo-tokyo.glb first, then run this script.")

    purge_previous()

    world = build_world()
    print("world      : %s (gradient sky, strength %.2f)" % (world.name, WORLD_STRENGTH))

    fog = build_fog_volume()
    print("fog        : %s, volume scatter density %.4f (FogExp2 %.4f matched at 100u)"
          % (fog.name, FOG_SCATTER_DENSITY, FOG_DENSITY_THREE))

    emitter, drop = build_rain()
    alive = int(RAIN_COUNT * RAIN_LIFETIME / max(RAIN_EMIT_UNTIL - 1.0, 1.0))
    print("rain       : %s, %d particles of %s (~%d alive at steady state)"
          % (emitter.name, RAIN_COUNT, drop.name, alive))

    counts = fix_materials()
    print("materials  : additive %d, holo %d, emissive %d, unlit %d, vcol %d"
          % (counts["additive"], counts["holo"], counts["emissive"],
             counts["unlit"], counts["vcol"]))

    cameras = build_cameras()
    print("cameras    : %s (scene camera = NT_CAM_%s)"
          % (", ".join(c.name for c in cameras), DEFAULT_SHOT))

    transform = configure_render()
    print("render     : Cycles, %dx%d, %d samples, view transform %s, film_transparent off"
          % (RESOLUTION[0], RESOLUTION[1], CYCLES_SAMPLES, transform))

    configure_compositor()
    print("compositor : Fog Glow glare (stands in for src/postfx.js bloom)")

    print("-" * 70)
    print("Next: scrub the timeline to ~frame %d so the rain reaches steady state"
          % int(RAIN_LIFETIME + 30))
    print("      before you render — at frame 1 the emitter has not fired yet.")
    print("      Tune FOG_SCATTER_DENSITY and the *_BOOST constants at the top of")
    print("      this script to taste, then re-run it; it replaces its own work.")
    print("=" * 70)


if __name__ == "__main__":
    main()

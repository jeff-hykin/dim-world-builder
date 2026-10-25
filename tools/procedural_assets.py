"""Office assets built from primitives (no outside model): writes one Z-up GLB per asset for cooker/cook.py.

    python tools/procedural_assets.py <out dir> [id ...]      # then cook each <out dir>/<id>.glb with --up z --srgb-factors

Run with the cooker's Python (trimesh, numpy). Meters, Z up, front (where you sit or face it from) toward +x.
Colors are sRGB. Kept low-poly: every piece is a box, a cylinder or a short revolve.
"""

import math
from pathlib import Path
import sys

import numpy as np
import trimesh
from trimesh.creation import box as _box, cylinder as _cylinder, revolve
from trimesh.transformations import rotation_matrix, translation_matrix

WHITE = (0.93, 0.93, 0.91)
OFF_WHITE = (0.85, 0.85, 0.83)
BLACK = (0.09, 0.09, 0.1)
CHARCOAL = (0.2, 0.2, 0.22)
GREY = (0.55, 0.56, 0.58)
STEEL = (0.72, 0.74, 0.76)
WICKER = (0.74, 0.56, 0.34)
CREAM = (0.9, 0.87, 0.78)
SAGE = (0.63, 0.72, 0.67)
CARDBOARD = (0.72, 0.55, 0.36)
TAPE = (0.8, 0.7, 0.52)
CLEAR = (0.82, 0.88, 0.92)


class Model:
    """colored parts, gathered into one scene"""

    def __init__(self):
        self.parts = []

    def add(self, mesh, color):
        mesh.visual = trimesh.visual.TextureVisuals(
            material=trimesh.visual.material.PBRMaterial(
                baseColorFactor=[*color, 1.0], metallicFactor=0.0, roughnessFactor=0.8
            )
        )
        self.parts.append(mesh)
        return mesh

    def box(self, size, center, color, rotate=None):
        """an axis-aligned box of `size` at `center`; rotate: (angle, axis) about its center"""
        mesh = _box(extents=size)
        if rotate:
            mesh.apply_transform(rotation_matrix(rotate[0], rotate[1]))
        mesh.apply_translation(center)
        return self.add(mesh, color)

    def rod(self, a, b, radius, color, sections=12):
        """a cylinder from point a to point b"""
        a, b = np.asarray(a, float), np.asarray(b, float)
        length = float(np.linalg.norm(b - a))
        mesh = _cylinder(radius=radius, height=length, sections=sections)
        mesh.apply_transform(trimesh.geometry.align_vectors([0, 0, 1], (b - a) / length))
        mesh.apply_translation((a + b) / 2)
        return self.add(mesh, color)

    def disc(self, radius, height, center, color, axis="z", sections=20):
        c = np.asarray(center, float)
        d = {"x": [height / 2, 0, 0], "y": [0, height / 2, 0], "z": [0, 0, height / 2]}[axis]
        return self.rod(c - d, c + d, radius, color, sections)

    def wheel(self, center, radius, color=BLACK, axis="y"):
        return self.disc(radius, radius * 0.8, center, color, axis=axis, sections=12)

    def lathe(self, profile, color, sections=24, transform=None):
        """a surface of revolution about z from (radius, z) points"""
        mesh = revolve(np.asarray(profile, float), sections=sections)
        if transform is not None:
            mesh.apply_transform(transform)
        return self.add(mesh, color)

    def save(self, path):
        scene = trimesh.Scene()
        for k, part in enumerate(self.parts):
            scene.add_geometry(part, node_name=f"part_{k}", geom_name=f"part_{k}")
        scene.export(str(path))


# ---------------------------------------------------------------- the assets


def sit_stand_desk():
    """white sit-stand desk: a thin top on two T-legs (columns on floor feet) and a crossbar"""
    m = Model()
    w, d, h, t = 1.4, 0.7, 0.75, 0.025
    m.box((w, d, t), (0, 0, h - t / 2), WHITE)
    for x in (-0.58, 0.58):
        m.box((0.07, 0.65, 0.035), (x, 0, 0.0175), OFF_WHITE)
        m.box((0.06, 0.08, h - t - 0.035), (x, 0, 0.035 + (h - t - 0.035) / 2), OFF_WHITE)
        m.box((0.06, 0.6, 0.03), (x, 0, h - t - 0.015), OFF_WHITE)
    m.box((1.1, 0.05, 0.05), (0, 0, h - t - 0.06), OFF_WHITE)
    # the height buttons, under the front edge
    m.box((0.06, 0.04, 0.02), (0.45, 0.31, h - t - 0.01), CHARCOAL)
    return m


def chair_base(m, color=BLACK, radius=0.32, caster=0.03):
    """a five-star base on casters, with the gas lift up to `top`"""
    for k in range(5):
        a = 2 * math.pi * k / 5
        end = (radius * math.cos(a), radius * math.sin(a), caster * 2 + 0.02)
        m.rod((0, 0, caster * 2 + 0.06), end, 0.022, color, sections=8)
        m.wheel((end[0], end[1], caster), caster, BLACK)


def mesh_office_chair():
    """black mesh-back ergonomic chair with a headrest and arms; it faces +x"""
    m = Model()
    chair_base(m)
    m.disc(0.03, 0.32, (0, 0, 0.27), STEEL)
    m.box((0.5, 0.5, 0.08), (0.02, 0, 0.47), BLACK)
    # the backrest: a mesh panel in a frame, leaning back
    lean = math.radians(-12)
    back = (-0.25, 0, 0.82)
    m.box((0.03, 0.46, 0.6), back, CHARCOAL, rotate=(lean, [0, 1, 0]))
    for y in (-0.24, 0.24):
        m.box((0.035, 0.03, 0.62), (back[0], y, back[2]), BLACK, rotate=(lean, [0, 1, 0]))
    m.box((0.04, 0.3, 0.12), (-0.33, 0, 1.2), BLACK, rotate=(lean, [0, 1, 0]))
    m.rod((-0.3, 0, 1.1), (-0.31, 0, 1.15), 0.015, BLACK)
    m.rod((-0.12, 0, 0.47), (-0.27, 0, 0.55), 0.03, BLACK)
    for y in (-0.27, 0.27):
        m.rod((-0.05, y, 0.5), (-0.05, y, 0.68), 0.018, BLACK)
        m.box((0.26, 0.07, 0.03), (0.0, y, 0.69), BLACK)
    return m


def papasan_chair():
    """a wicker bowl with a cushion on a round wicker base, ~1.1 m across"""
    m = Model()
    m.lathe([(0.0, 0.0), (0.36, 0.0), (0.33, 0.12), (0.22, 0.34), (0.0, 0.34)], WICKER)
    tilt = rotation_matrix(math.radians(-14), [0, 1, 0])
    lift = translation_matrix((0, 0, 0.33))
    bowl = [(0.0, 0.0), (0.2, 0.0), (0.42, 0.12), (0.55, 0.32), (0.56, 0.4), (0.5, 0.36), (0.38, 0.17), (0.0, 0.07)]
    m.lathe(bowl, WICKER, sections=28, transform=lift @ tilt)
    cushion = [(0.0, 0.06), (0.4, 0.15), (0.5, 0.33), (0.45, 0.36), (0.3, 0.24), (0.0, 0.18)]
    m.lathe(cushion, CREAM, sections=28, transform=lift @ tilt)
    return m


def rolling_whiteboard():
    """a whiteboard (both faces, x) in an aluminium frame on two feet with casters, 1.2 wide and 1.9 tall"""
    m = Model()
    m.box((0.025, 1.2, 1.0), (0, 0, 1.3), WHITE)
    for z in (0.79, 1.81):
        m.box((0.035, 1.24, 0.03), (0, 0, z), STEEL)
    for y in (-0.62, 0.62):
        m.box((0.04, 0.04, 1.8), (0, y, 0.98), STEEL)
        m.box((0.6, 0.05, 0.04), (0, y, 0.07), STEEL)
        for x in (-0.27, 0.27):
            m.wheel((x, y, 0.025), 0.025, BLACK, axis="y")
    m.box((0.08, 0.6, 0.02), (0.05, 0, 0.78), STEEL)
    return m


def storage_bin_clear():
    """a clear plastic tote with a lid, 0.6 x 0.4 x 0.35"""
    m = Model()
    w, d, h, t = 0.6, 0.4, 0.33, 0.006
    m.box((w - 0.04, d - 0.04, t), (0, 0, t / 2), CLEAR)
    for side in (-1, 1):
        m.box((t, d - 0.02, h), (side * (w / 2 - 0.01), 0, h / 2), CLEAR, rotate=(side * math.radians(-3), [0, 1, 0]))
        m.box((w - 0.02, t, h), (0, side * (d / 2 - 0.01), h / 2), CLEAR, rotate=(side * math.radians(3), [1, 0, 0]))
    m.box((w + 0.01, d + 0.01, 0.02), (0, 0, h + 0.01), (0.7, 0.78, 0.84))
    return m


def equipment_case():
    """a black hard-shell wheeled equipment case (Pelican-style) lying flat, 0.85 x 0.55 x 0.5"""
    m = Model()
    w, d, h = 0.85, 0.55, 0.47
    m.box((w, d, h - 0.06), (0, 0, 0.03 + (h - 0.06) / 2 + 0.03), BLACK)
    m.box((w + 0.012, d + 0.012, 0.03), (0, 0, 0.03 + h * 0.62), CHARCOAL)
    for y in (-0.2, 0.2):
        m.box((0.03, 0.08, 0.05), (w / 2 + 0.01, y, 0.03 + h * 0.62), GREY)
        m.wheel((-w / 2 + 0.05, y * 1.2, 0.035), 0.035, BLACK)
        m.box((0.05, 0.05, 0.03), (w / 2 - 0.05, y * 1.2, 0.015), CHARCOAL)
    m.box((0.03, 0.18, 0.025), (0, 0, h + 0.04), CHARCOAL)
    m.rod((-w / 2 - 0.015, -0.12, 0.35), (-w / 2 - 0.015, 0.12, 0.35), 0.012, CHARCOAL)
    return m


def hardshell_suitcase():
    """an upright hard-shell spinner suitcase with its handle down, 0.45 x 0.28 x 0.72"""
    m = Model()
    m.box((0.28, 0.45, 0.62), (0, 0, 0.06 + 0.31), (0.33, 0.35, 0.38))
    for x in (-0.07, 0.07):
        m.box((0.004, 0.43, 0.6), (x + (0.14 if x > 0 else -0.14), 0, 0.37), (0.28, 0.3, 0.33))
    for x in (-0.1, 0.1):
        for y in (-0.18, 0.18):
            m.wheel((x, y, 0.03), 0.03, BLACK, axis="x")
    for y in (-0.08, 0.08):
        m.rod((-0.1, y, 0.68), (-0.1, y, 0.72), 0.01, STEEL)
    m.box((0.03, 0.2, 0.025), (-0.1, 0, 0.72), BLACK)
    return m


def bin_cart():
    """a black open-top tote on a four-caster dolly"""
    m = Model()
    m.box((0.62, 0.44, 0.04), (0, 0, 0.1), CHARCOAL)
    for x in (-0.25, 0.25):
        for y in (-0.17, 0.17):
            m.disc(0.02, 0.05, (x, y, 0.065), STEEL, sections=8)
            m.wheel((x, y, 0.035), 0.035, BLACK)
    w, d, h, t = 0.58, 0.4, 0.42, 0.012
    base = 0.12
    m.box((w - 0.04, d - 0.04, t), (0, 0, base + t / 2), BLACK)
    for side in (-1, 1):
        m.box((t, d, h), (side * (w / 2 - t / 2), 0, base + h / 2), BLACK)
        m.box((w, t, h), (0, side * (d / 2 - t / 2), base + h / 2), BLACK)
    m.box((w + 0.03, d + 0.03, 0.02), (0, 0, base + h), BLACK)
    return m


def sofa_module():
    """one low modular sofa seat with a back cushion (light sage), 0.95 x 0.95"""
    m = Model()
    m.box((0.95, 0.95, 0.3), (0, 0, 0.15), SAGE)
    m.box((0.8, 0.92, 0.12), (0.06, 0, 0.36), (0.66, 0.75, 0.7))
    m.box((0.22, 0.95, 0.38), (-0.365, 0, 0.49), SAGE)
    return m


def ottoman_block():
    """a low square ottoman block (light sage), 0.95 x 0.95 x 0.42"""
    m = Model()
    m.box((0.95, 0.95, 0.3), (0, 0, 0.15), SAGE)
    m.box((0.92, 0.92, 0.12), (0, 0, 0.36), (0.66, 0.75, 0.7))
    return m


def power_rack():
    """a white steel pull-up / dip station: two uprights on long feet, a top bar, dip handles and a back pad"""
    m = Model()
    s = 0.06
    for y in (-0.5, 0.5):
        m.box((1.1, 0.08, s), (0, y, s / 2), WHITE)
        m.box((s, s, 2.2), (-0.15, y, 1.1), WHITE)
        m.box((0.5, s, s), (0.08, y, 2.12), WHITE)
        m.rod((0.3, y, 2.12), (0.45, y * 0.8, 2.12), 0.016, CHARCOAL)
        m.box((0.4, 0.05, 0.05), (0.05, y * 0.75, 1.2), WHITE)
        m.box((0.22, 0.06, 0.06), (0.22, y * 0.75, 1.2), CHARCOAL)
    m.rod((-0.15, -0.55, 2.2), (-0.15, 0.55, 2.2), 0.018, STEEL)
    m.box((s, 1.0, s), (-0.15, 0, 1.6), WHITE)
    m.box((s, 1.0, s), (-0.15, 0, 0.35), WHITE)
    m.box((0.06, 0.35, 0.5), (-0.1, 0, 1.25), BLACK)
    m.box((0.06, 0.3, 0.2), (-0.1, 0, 0.75), BLACK)
    return m


def exercise_bike():
    """a stationary bike facing +x: frame, front flywheel, saddle, handlebars"""
    m = Model()
    for x in (-0.48, 0.42):
        m.box((0.08, 0.5, 0.05), (x, 0, 0.025), BLACK)
    m.rod((-0.48, 0, 0.05), (0.42, 0, 0.05), 0.03, CHARCOAL)
    m.disc(0.25, 0.06, (0.3, 0, 0.36), CHARCOAL, axis="y", sections=24)
    m.rod((-0.25, 0, 0.05), (0.15, 0, 0.62), 0.035, BLACK)
    m.rod((0.42, 0, 0.05), (0.33, 0, 1.0), 0.035, BLACK)
    m.rod((-0.2, 0, 0.3), (-0.3, 0, 0.88), 0.03, BLACK)
    m.box((0.28, 0.2, 0.07), (-0.32, 0, 0.92), BLACK)
    m.rod((0.33, -0.25, 1.05), (0.33, 0.25, 1.05), 0.018, CHARCOAL)
    m.rod((0.33, -0.25, 1.05), (0.45, -0.25, 1.1), 0.018, CHARCOAL)
    m.rod((0.33, 0.25, 1.05), (0.45, 0.25, 1.1), 0.018, CHARCOAL)
    m.box((0.12, 0.18, 0.08), (0.37, 0, 1.08), GREY)
    m.disc(0.08, 0.04, (-0.0, 0, 0.32), GREY, axis="y")
    return m


def robot_dog_lying():
    """a quadruped robot dog (Go2-like) lying down, legs folded along its sides, head toward +x: 0.7 x 0.3 x 0.3"""
    m = Model()
    m.box((0.5, 0.2, 0.13), (0, 0, 0.17), (0.78, 0.79, 0.8))
    m.box((0.36, 0.18, 0.025), (-0.02, 0, 0.245), CHARCOAL)
    m.box((0.12, 0.17, 0.11), (0.29, 0, 0.18), CHARCOAL)
    m.box((0.02, 0.12, 0.05), (0.355, 0, 0.18), BLACK)
    for x in (-0.18, 0.17):
        for y in (-0.125, 0.125):
            m.disc(0.05, 0.05, (x, y, 0.17), CHARCOAL, axis="y")
            m.box((0.22, 0.04, 0.05), (x - 0.06, y * 1.05, 0.11), (0.78, 0.79, 0.8), rotate=(math.radians(-20), [0, 1, 0]))
            m.box((0.22, 0.03, 0.035), (x + 0.03, y * 1.05, 0.03), CHARCOAL)
            m.disc(0.022, 0.03, (x + 0.14, y * 1.05, 0.022), BLACK, axis="y")
    m.disc(0.035, 0.06, (0.22, 0, 0.27), BLACK)
    return m


def humanoid_gantry():
    """a humanoid robot (~1.3 m, G1-like) hanging from a mobile gantry: H-base on casters, mast, boom, strap"""
    m = Model()
    for y in (-0.45, 0.45):
        m.box((1.1, 0.07, 0.07), (0, y, 0.085), BLACK)
        for x in (-0.5, 0.5):
            m.wheel((x, y, 0.03), 0.03, BLACK)
    m.box((0.07, 0.97, 0.07), (-0.5, 0, 0.085), BLACK)
    m.box((0.08, 0.08, 2.3), (-0.5, 0, 1.2), BLACK)
    m.box((0.75, 0.07, 0.07), (-0.16, 0, 2.3), BLACK)
    m.rod((-0.46, 0, 1.6), (-0.2, 0, 2.26), 0.02, BLACK)
    m.rod((0.15, 0, 2.27), (0.15, 0, 1.55), 0.008, (0.85, 0.5, 0.15))
    # the robot, hanging with its feet just off the floor
    body, dark = (0.75, 0.76, 0.78), CHARCOAL
    x = 0.15
    m.box((0.12, 0.14, 0.12), (x, 0, 1.43), dark)
    m.box((0.14, 0.3, 0.3), (x, 0, 1.2), body)
    m.box((0.12, 0.24, 0.12), (x, 0, 0.98), dark)
    for y in (-0.19, 0.19):
        m.rod((x, y, 1.32), (x + 0.02, y * 1.05, 1.05), 0.035, body)
        m.rod((x + 0.02, y * 1.05, 1.05), (x + 0.1, y * 1.05, 0.86), 0.03, dark)
    for y in (-0.08, 0.08):
        m.rod((x, y, 0.92), (x + 0.03, y, 0.55), 0.045, body)
        m.rod((x + 0.03, y, 0.55), (x - 0.01, y, 0.17), 0.04, dark)
        m.box((0.2, 0.08, 0.04), (x + 0.04, y, 0.13), dark)
    return m


def cardboard(m, size, center):
    w, d, h = size
    m.box(size, center, CARDBOARD)
    m.box((w + 0.002, 0.06, 0.004), (center[0], center[1], center[2] + h / 2), TAPE)


def cardboard_box_small():
    m = Model()
    cardboard(m, (0.3, 0.25, 0.2), (0, 0, 0.1))
    return m


def cardboard_box_large():
    m = Model()
    cardboard(m, (0.6, 0.45, 0.45), (0, 0, 0.225))
    return m


def cardboard_box_stack():
    """three boxes stacked, each a little turned"""
    m = Model()
    cardboard(m, (0.6, 0.45, 0.42), (0, 0, 0.21))
    box = _box(extents=(0.48, 0.38, 0.32))
    box.apply_transform(rotation_matrix(math.radians(8), [0, 0, 1]))
    box.apply_translation((0.02, 0.01, 0.42 + 0.16))
    m.add(box, CARDBOARD)
    top = _box(extents=(0.32, 0.26, 0.22))
    top.apply_transform(rotation_matrix(math.radians(-12), [0, 0, 1]))
    top.apply_translation((-0.03, -0.02, 0.74 + 0.11))
    m.add(top, (0.68, 0.52, 0.34))
    return m


ASSETS = {
    "sit_stand_desk": ("Sit-Stand Desk (white)", "furniture", sit_stand_desk),
    "mesh_office_chair": ("Mesh Office Chair", "furniture", mesh_office_chair),
    "papasan_chair": ("Papasan Chair", "furniture", papasan_chair),
    "rolling_whiteboard": ("Rolling Whiteboard", "office", rolling_whiteboard),
    "storage_bin_clear": ("Clear Storage Bin", "storage", storage_bin_clear),
    "equipment_case": ("Wheeled Equipment Case", "storage", equipment_case),
    "hardshell_suitcase": ("Hard-Shell Suitcase", "storage", hardshell_suitcase),
    "bin_cart": ("Bin Cart", "storage", bin_cart),
    "sofa_module": ("Modular Sofa Seat (sage)", "furniture", sofa_module),
    "ottoman_block": ("Ottoman Block (sage)", "furniture", ottoman_block),
    "power_rack": ("Pull-Up / Dip Station", "gym", power_rack),
    "exercise_bike": ("Exercise Bike", "gym", exercise_bike),
    "robot_dog_lying": ("Robot Dog (lying down)", "robots", robot_dog_lying),
    "humanoid_gantry": ("Humanoid on a Gantry", "robots", humanoid_gantry),
    "cardboard_box_small": ("Small Cardboard Box", "storage", cardboard_box_small),
    "cardboard_box_large": ("Large Cardboard Box", "storage", cardboard_box_large),
    "cardboard_box_stack": ("Stacked Cardboard Boxes", "storage", cardboard_box_stack),
}


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    for asset_id in sys.argv[2:] or ASSETS:
        name, category, build = ASSETS[asset_id]
        build().save(out / f"{asset_id}.glb")
        print(f"{asset_id}\t{name}\t{category}")


if __name__ == "__main__":
    main()

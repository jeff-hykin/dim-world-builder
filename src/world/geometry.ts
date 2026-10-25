// Project -> World: every item as a rigid body of MuJoCo-shaped geometry. The page draws exactly this and the exporter
// writes exactly this, so what the editor shows is what the robot collides with and the lidar sees.

import { fbm } from "./noise.ts";
import type {
  AprilTagParams,
  DoorOpening,
  Floor,
  FloorFinish,
  HillParams,
  HoleParams,
  Item,
  MeshAsset,
  PrimitiveParams,
  Project,
  Quat,
  Rgb,
  RoomParams,
  StairsParams,
  Vec3,
} from "./types.ts";

export type Rgba = [number, number, number, number];

/** "both": collides and is seen; "visual": seen only (lidar, camera); "collision": collides only (hidden). */
/** "editor": drawn only in the editor (a handle to pick), never exported */
export type Role = "both" | "visual" | "collision" | "editor";

export interface InlineMesh {
  vertices: number[];
  faces: number[];
  /** per-vertex (u, v), when the mesh carries an image */
  texcoords?: number[];
}

export interface Shape {
  type: "box" | "cylinder" | "sphere" | "ellipsoid" | "mesh" | "hfield";
  pos: Vec3;
  /** [x, y, z, w] */
  quat: Quat;
  /** MuJoCo sizes: box half-extents, cylinder [radius, half-height], sphere [radius], ellipsoid radii */
  size: number[];
  mesh?: InlineMesh;
  meshFile?: { asset: string; file: string; scale: Vec3 };
  /** an image on the shape's +x face (AprilTags): a path under the app's assets, e.g. apriltags/tag36h11_00003.png */
  texture?: string;
  /** a photo on the shape's +x face (image items): the editor draws it, the export never writes it */
  image?: { src: string; opacity: number; doubleSided: boolean };
  /** a surface look the views draw on top of rgba (a floor slab's concrete) */
  finish?: Exclude<FloorFinish, "plain">;
  hfield?: {
    nrow: number;
    ncol: number;
    size: [number, number, number, number];
    elevation: number[];
  };
  rgba: Rgba;
  role: Role;
}

export interface WorldLight {
  type: "point" | "spot" | "sun";
  /** [r, g, b] times intensity */
  rgb: Vec3;
  range: number;
  angle: number;
  shadows: boolean;
}

export interface Body {
  /** MJCF body name and scene entity id */
  name: string;
  label: string;
  kind: string;
  itemId: string;
  floor: string;
  pos: Vec3;
  quat: Quat;
  mocap: boolean;
  shapes: Shape[];
  /** lights carried by the body: they shine down its -z (spot, sun) from its origin */
  lights?: WorldLight[];
}

export interface WorldMover {
  body: string;
  waypoints: Vec3[];
  speed: number;
  mode: "loop" | "pingpong";
  heading: "path" | "fixed";
}

export interface World {
  /** where MuJoCo's infinite ground plane sits: 0, or under the ground floor's slab */
  groundZ: number;
  bodies: Body[];
  spawns: { name: string; pos: Vec3; yaw: number }[];
  movers: WorldMover[];
  /** the project's remembered views, as fixed world cameras */
  cameras: WorldCamera[];
}

export interface WorldCamera {
  name: string;
  label: string;
  pos: Vec3;
  /** MuJoCo's xyaxes: the camera's right then up direction (it looks down its -z) */
  xyaxes: [number, number, number, number, number, number];
  fovy: number;
}

/** a camera at `eye` looking at `target`, with world +z up */
export function cameraLookAt(eye: Vec3, target: Vec3): WorldCamera["xyaxes"] {
  const norm = (v: number[]) => {
    const l = Math.hypot(...v) || 1;
    return v.map((x) => x / l);
  };
  const cross = (a: number[], b: number[]) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const forward = norm(target.map((t, i) => t - eye[i]));
  // looking straight up or down: +y stands in for up
  const up = Math.abs(forward[2]) > 0.999 ? [0, 1, 0] : [0, 0, 1];
  const right = norm(cross(forward, up));
  const cameraUp = cross(right, forward);
  return [...right, ...cameraUp] as WorldCamera["xyaxes"];
}

const IDENTITY: Quat = [0, 0, 0, 1];
const rgba = (color: Rgb, alpha = 1): Rgba => [color[0], color[1], color[2], alpha];

/** MJCF-safe, unique-ish body name from an item's name and id */
export function bodyName(item: Item): string {
  if (item.key) return item.key;
  const base = item.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") ||
    item.kind;
  return `${base}_${item.id.slice(0, 6)}`;
}

function box(center: Vec3, size: Vec3, color: Rgba, role: Role = "both"): Shape {
  return {
    type: "box",
    pos: center,
    quat: IDENTITY,
    size: [size[0] / 2, size[1] / 2, size[2] / 2],
    rgba: color,
    role,
  };
}

// ── generated meshes (convex, so MuJoCo's hull of them is the mesh itself) ──

function coneMesh(radius: number, height: number, segments = 24): InlineMesh {
  const vertices: number[] = [0, 0, height, 0, 0, 0];
  const faces: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    vertices.push(Math.cos(a) * radius, Math.sin(a) * radius, 0);
  }
  for (let i = 0; i < segments; i++) {
    const a = 2 + i;
    const b = 2 + ((i + 1) % segments);
    faces.push(0, a, b, 1, b, a);
  }
  return { vertices, faces };
}

/** a wedge rising along +x: full height at +x/2, zero at -x/2 */
function rampMesh(sx: number, sy: number, sz: number): InlineMesh {
  const x0 = -sx / 2, x1 = sx / 2, y0 = -sy / 2, y1 = sy / 2;
  const vertices = [x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0, x1, y0, sz, x1, y1, sz];
  const faces = [0, 2, 1, 0, 3, 2, 1, 2, 5, 1, 5, 4, 0, 1, 4, 3, 5, 2, 0, 4, 5, 0, 5, 3];
  return { vertices, faces };
}

/** a slumped, lumpy blob: an ellipsoid flattened at the bottom, with a soft dent on top */
function beanbagMesh(sx: number, sy: number, sz: number, rings = 12, segments = 24): InlineMesh {
  const vertices: number[] = [];
  const faces: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const v = r / rings;
    const phi = v * Math.PI;
    for (let s = 0; s < segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      const lump = 1 + 0.06 * Math.sin(theta * 3) * Math.sin(phi);
      let x = Math.sin(phi) * Math.cos(theta) * lump;
      let y = Math.sin(phi) * Math.sin(theta) * lump;
      let z = Math.cos(phi);
      z = z < -0.55 ? -0.55 : z; // sits flat
      if (z > 0.6) z = 0.6 + (z - 0.6) * 0.4; // a seat dent
      x *= sx / 2;
      y *= sy / 2;
      vertices.push(x, y, ((z + 0.55) / 1.15) * sz);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * segments + s;
      const b = r * segments + ((s + 1) % segments);
      const c = a + segments;
      const d = b + segments;
      faces.push(a, c, b, b, c, d);
    }
  }
  return { vertices, faces };
}

/** rotation of `angle` about a unit axis, as [x, y, z, w] */
function axisAngle(axis: Vec3, angle: number): Quat {
  const half = Math.sin(angle / 2);
  return [axis[0] * half, axis[1] * half, axis[2] * half, Math.cos(angle / 2)];
}

/** a then b: the rotation b applied after a, both [x, y, z, w] */
function multiplyQuat(b: Quat, a: Quat): Quat {
  return [
    b[3] * a[0] + b[0] * a[3] + b[1] * a[2] - b[2] * a[1],
    b[3] * a[1] - b[0] * a[2] + b[1] * a[3] + b[2] * a[0],
    b[3] * a[2] + b[0] * a[1] - b[1] * a[0] + b[2] * a[3],
    b[3] * a[3] - b[0] * a[0] - b[1] * a[1] - b[2] * a[2],
  ];
}

/** shapes turned by `yaw` about z, then moved by `offset` */
function placeShapes(shapes: Shape[], yaw: number, offset: Vec3): Shape[] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const turn = axisAngle([0, 0, 1], yaw);
  return shapes.map((shape) => ({
    ...shape,
    pos: [
      c * shape.pos[0] - s * shape.pos[1] + offset[0],
      s * shape.pos[0] + c * shape.pos[1] + offset[1],
      shape.pos[2] + offset[2],
    ],
    quat: multiplyQuat(turn, shape.quat),
  }));
}

function rotatedBox(center: Vec3, size: Vec3, quat: Quat, color: Rgba, role: Role = "both"): Shape {
  return { ...box(center, size, color, role), quat };
}

function cylinderAlong(
  axis: "x" | "y" | "z",
  center: Vec3,
  radius: number,
  length: number,
  color: Rgba,
  role: Role = "both",
): Shape {
  const quat: Quat = axis === "z"
    ? IDENTITY
    : axis === "x"
    ? axisAngle([0, 1, 0], Math.PI / 2)
    : axisAngle([1, 0, 0], Math.PI / 2);
  return { type: "cylinder", pos: center, quat, size: [radius, length / 2], rgba: color, role };
}

/** a surface of revolution around +z from a (radius, height) profile; `closed` caps both ends */
function latheMesh(profile: [number, number][], segments = 24): InlineMesh {
  const vertices: number[] = [];
  const faces: number[] = [];
  for (const [r, z] of profile) {
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      vertices.push(Math.cos(a) * r, Math.sin(a) * r, z);
    }
  }
  for (let ring = 0; ring < profile.length - 1; ring++) {
    for (let s = 0; s < segments; s++) {
      const a = ring * segments + s;
      const b = ring * segments + ((s + 1) % segments);
      faces.push(a, b, a + segments, b, b + segments, a + segments);
    }
  }
  return { vertices, faces };
}

function mapVertices(mesh: InlineMesh, f: (x: number, y: number, z: number) => Vec3): InlineMesh {
  const vertices: number[] = [];
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    vertices.push(...f(mesh.vertices[i], mesh.vertices[i + 1], mesh.vertices[i + 2]));
  }
  return { vertices, faces: mesh.faces };
}

const visualMesh = (mesh: InlineMesh, color: Rgba): Shape => ({
  type: "mesh",
  pos: [0, 0, 0],
  quat: IDENTITY,
  size: [],
  mesh,
  rgba: color,
  role: "visual",
});

/** a bowling pin: a lathe for the look, an ellipsoid belly + neck + head to collide with */
function bowlingPinShapes(sx: number, sy: number, sz: number, color: Rgba): Shape[] {
  const r = Math.max(sx, sy) / 2;
  const profile: [number, number][] = [
    [0, 0],
    [0.55, 0],
    [0.8, 0.08],
    [1, 0.25],
    [0.95, 0.4],
    [0.62, 0.58],
    [0.42, 0.7],
    [0.5, 0.82],
    [0.55, 0.9],
    [0.42, 0.97],
    [0, 1],
  ];
  const pin = latheMesh(profile.map(([pr, pz]) => [pr * r, pz * sz]));
  return [
    visualMesh(pin, color),
    {
      type: "ellipsoid",
      pos: [0, 0, 0.28 * sz],
      quat: IDENTITY,
      size: [r, r, 0.28 * sz],
      rgba: color,
      role: "collision",
    },
    cylinderAlong("z", [0, 0, 0.64 * sz], 0.5 * r, 0.2 * sz, color, "collision"),
    {
      type: "sphere",
      pos: [0, 0, 0.87 * sz],
      quat: IDENTITY,
      size: [0.55 * r],
      rgba: color,
      role: "collision",
    },
  ];
}

/** a hollow pipe lying along x: a tube for the look, a ring of boxes to collide with (MuJoCo can't do hollow) */
function pipeShapes(sx: number, sy: number, sz: number, color: Rgba): Shape[] {
  const radius = Math.min(sy, sz) / 2;
  const wall = Math.max(0.01, radius * 0.15);
  const inner = radius - wall;
  const half = sx / 2;
  const tube = latheMesh([[inner, -half], [radius, -half], [radius, half], [inner, half], [
    inner,
    -half,
  ]], 28);
  const shapes: Shape[] = [visualMesh(mapVertices(tube, (x, y, z) => [z, x, y + radius]), color)];
  const pieces = 14;
  const chord = 2 * radius * Math.sin(Math.PI / pieces) * 1.05;
  for (let i = 0; i < pieces; i++) {
    const a = (i / pieces) * Math.PI * 2;
    const middle = radius - wall / 2;
    shapes.push(rotatedBox(
      [0, Math.cos(a) * middle, radius + Math.sin(a) * middle],
      [sx, wall, chord],
      axisAngle([1, 0, 0], a),
      color,
      "collision",
    ));
  }
  return shapes;
}

/** a two-step stool: a low step in front (-x), the top step behind (+x), each on its own side panels */
function stepStoolShapes(sx: number, sy: number, sz: number, color: Rgba): Shape[] {
  const t = Math.min(0.03, sz * 0.08);
  const low = sz * 0.48;
  const shapes: Shape[] = [];
  for (const [x, height] of [[-sx / 4, low], [sx / 4, sz]] as const) {
    shapes.push(box([x, 0, height - t / 2], [sx / 2, sy, t], color));
    for (const side of [1, -1]) {
      shapes.push(box([x, side * (sy / 2 - t / 2), height / 2], [sx / 2, t, height], color));
    }
  }
  return shapes;
}

/** a ladder lying flat on the ground: two rails along x and round rungs across */
function ladderShapes(sx: number, sy: number, sz: number, color: Rgba): Shape[] {
  const rail = Math.min(0.05, sy * 0.12);
  const shapes = [
    box([0, sy / 2 - rail / 2, sz / 2], [sx, rail, sz], color),
    box([0, -sy / 2 + rail / 2, sz / 2], [sx, rail, sz], color),
  ];
  const rungs = Math.max(2, Math.round(sx / 0.3));
  for (let i = 0; i < rungs; i++) {
    const x = -sx / 2 + (i + 0.5) * (sx / rungs);
    shapes.push(cylinderAlong("y", [x, 0, sz / 2], sz * 0.3, sy - 2 * rail, color));
  }
  return shapes;
}

type Ring = { t: number; w: number; d: number; dx?: number; rot?: number };

/**
 * a low-poly limb: polygon rings (`sides` corners) swept from a to b, each `w` wide (across), `d` deep (front-back)
 * and nudged `dx` forward; interior rings turn by `rot` for the faceted, crystal look, the end rings stay square so
 * neighboring parts meet cleanly
 */
function loftMesh(a: Vec3, b: Vec3, rings: Ring[], sides = 6, twist = Math.PI / sides): InlineMesh {
  const axis: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const length = Math.hypot(...axis);
  const up: Vec3 = [axis[0] / length, axis[1] / length, axis[2] / length];
  // front is +x taken off the bone, across completes the frame
  const raw: Vec3 = [1 - up[0] * up[0], -up[0] * up[1], -up[0] * up[2]];
  const rawLength = Math.hypot(...raw);
  const front: Vec3 = rawLength < 1e-3
    ? [0, 0, 1]
    : [raw[0] / rawLength, raw[1] / rawLength, raw[2] / rawLength];
  const across: Vec3 = [
    up[1] * front[2] - up[2] * front[1],
    up[2] * front[0] - up[0] * front[2],
    up[0] * front[1] - up[1] * front[0],
  ];
  const vertices: number[] = [];
  const faces: number[] = [];
  rings.forEach((ring, r) => {
    const interior = r > 0 && r < rings.length - 1;
    const c = [a[0] + axis[0] * ring.t, a[1] + axis[1] * ring.t, a[2] + axis[2] * ring.t];
    for (let i = 0; i < sides; i++) {
      const angle = twist + (interior ? ring.rot ?? 0 : 0) + (i / sides) * Math.PI * 2;
      const f = Math.cos(angle) * ring.d + (ring.dx ?? 0);
      const g = Math.sin(angle) * ring.w;
      vertices.push(
        c[0] + front[0] * f + across[0] * g,
        c[1] + front[1] * f + across[1] * g,
        c[2] + front[2] * f + across[2] * g,
      );
    }
  });
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < sides; i++) {
      const p = r * sides + i, q = r * sides + ((i + 1) % sides);
      faces.push(p, q, q + sides, p, q + sides, p + sides);
    }
  }
  const last = (rings.length - 1) * sides;
  for (let i = 1; i < sides - 1; i++) faces.push(0, i + 1, i, last, last + i, last + i + 1);
  return { vertices, faces };
}

type Cloth = "skin" | "shirt" | "pants" | "shoes";

/** a faceted, Superhot-style mannequin 1.75 m tall, facing +x: [what it's dressed in, mesh] per part */
function mannequinParts(): [Cloth, InlineMesh][] {
  let k = 0;
  const R = (t: number, w: number, d: number, dx = 0): Ring => ({
    t,
    w,
    d,
    dx,
    rot: (k++ % 2 ? 1 : -1) * 0.18,
  });
  // the torso stays untwisted, so its broad faces read as clean planes
  const S = (t: number, w: number, d: number, dx = 0): Ring => ({ t, w, d, dx });
  const parts: [Cloth, InlineMesh][] = [
    // a skull with a flat face plane, jaw narrower, crown back
    [
      "skin",
      loftMesh(
        [0, 0, 1.52],
        [-0.01, 0, 1.76],
        [
          R(0, 0.04, 0.045, 0.035),
          R(0.15, 0.065, 0.075, 0.025),
          R(0.42, 0.085, 0.105, 0.005),
          R(0.75, 0.083, 0.1, -0.012),
          R(1, 0.04, 0.05, -0.02),
        ],
        6,
        0,
      ),
    ],
    ["skin", loftMesh([-0.012, 0, 1.4], [0, 0, 1.56], [R(0, 0.065, 0.06), R(1, 0.05, 0.05)])],
    // a broad chest with the pecs forward, narrowing to the ribs
    [
      "shirt",
      loftMesh(
        [0, 0, 1.15],
        [0, 0, 1.47],
        [
          S(0, 0.14, 0.105),
          S(0.4, 0.185, 0.135, 0.018),
          S(0.62, 0.2, 0.14, 0.022),
          S(0.86, 0.215, 0.115),
          S(1, 0.15, 0.08, -0.015),
        ],
        6,
        0,
      ),
    ],
    [
      "shirt",
      loftMesh(
        [0, 0, 0.98],
        [0, 0, 1.18],
        [S(0, 0.14, 0.1), S(0.5, 0.125, 0.095, 0.008), S(1, 0.14, 0.1)],
        6,
        0,
      ),
    ],
    [
      "pants",
      loftMesh(
        [0, 0, 0.84],
        [0, 0, 1.0],
        [S(0, 0.12, 0.09), S(0.45, 0.165, 0.11), S(1, 0.145, 0.1)],
        6,
        0,
      ),
    ],
  ];
  for (const side of [1, -1]) {
    const y = (v: number) => side * v;
    parts.push(
      [
        "shirt",
        loftMesh([-0.01, y(0.15), 1.42], [-0.01, y(0.26), 1.36], [
          R(0, 0.06, 0.07),
          R(0.6, 0.065, 0.068),
          R(1, 0.04, 0.05),
        ]),
      ],
      [
        "pants",
        loftMesh([0, y(0.088), 0.97], [0.012, y(0.105), 0.5], [
          R(0, 0.09, 0.098),
          R(0.3, 0.095, 0.1),
          R(1, 0.062, 0.064),
        ]),
      ],
      [
        "pants",
        loftMesh([0.012, y(0.105), 0.52], [-0.01, y(0.105), 0.075], [
          R(0, 0.062, 0.064),
          R(0.28, 0.066, 0.074, -0.01),
          R(1, 0.042, 0.045),
        ]),
      ],
      [
        "shoes",
        loftMesh(
          [-0.065, y(0.105), 0.06],
          [0.18, y(0.11), 0.03],
          [R(0, 0.045, 0.06), R(0.55, 0.055, 0.045), R(1, 0.04, 0.022)],
          4,
          Math.PI / 4,
        ),
      ],
      // arms hang a little away from the body, elbows soft
      [
        "shirt",
        loftMesh([-0.012, y(0.24), 1.38], [-0.025, y(0.275), 1.1], [
          R(0, 0.06, 0.065),
          R(0.35, 0.058, 0.06),
          R(1, 0.044, 0.046),
        ]),
      ],
      [
        "skin",
        loftMesh([-0.025, y(0.275), 1.11], [0.03, y(0.3), 0.85], [
          R(0, 0.044, 0.046),
          R(0.25, 0.048, 0.051),
          R(1, 0.032, 0.034),
        ]),
      ],
      [
        "skin",
        loftMesh([0.03, y(0.3), 0.86], [0.05, y(0.305), 0.7], [
          R(0, 0.026, 0.033),
          R(0.45, 0.022, 0.048, 0.006),
          R(1, 0.014, 0.028, 0.012),
        ]),
      ],
    );
  }
  return parts;
}

/**
 * a standing person facing +x (so a mover with heading "path" walks forward): a faceted mannequin in a shirt of
 * `color`, sz tall (sx and sy widen or narrow it); a box for collisions
 */
function personShapes(sx: number, sy: number, sz: number, color: Rgba): Shape[] {
  const look: Record<Cloth, Rgba> = {
    skin: [0.93, 0.93, 0.93, 1],
    shirt: color,
    pants: [0.23, 0.25, 0.29, 1],
    shoes: [0.13, 0.13, 0.15, 1],
  };
  // the mannequin is 1.76 m tall; the palette's 0.45 x 0.28 footprint keeps its own proportions
  const grow = sz / 1.76;
  const scale: Vec3 = [grow * sy / 0.28, grow * sx / 0.45, grow];
  const shapes: Shape[] = mannequinParts().map(([cloth, mesh]) =>
    visualMesh(
      mapVertices(mesh, (x, y, z) => [x * scale[0], y * scale[1], z * scale[2]]),
      look[cloth],
    )
  );
  shapes.push(box([0, 0, sz / 2], [sy * 0.8, sx * 0.8, sz], color, "collision"));
  return shapes;
}

/** an open-topped bucket / can: tapered walls you can see into, a solid cylinder to collide with */
function bucketShapes(sx: number, sy: number, sz: number, color: Rgba): Shape[] {
  const r = Math.max(sx, sy) / 2;
  const wall = latheMesh([[0, 0], [r * 0.82, 0], [r, sz], [r * 0.94, sz], [r * 0.77, 0.03 * sz], [
    0,
    0.03 * sz,
  ]]);
  return [
    visualMesh(wall, color),
    cylinderAlong("z", [0, 0, sz / 2], r * 0.92, sz, color, "collision"),
  ];
}

function primitiveShapes(params: PrimitiveParams, scale: Vec3): Shape[] {
  const [sx, sy, sz] = scale.map((v) => Math.max(Math.abs(v), 0.01)) as Vec3;
  const color = rgba(params.color);
  const lift: Vec3 = [0, 0, sz / 2];
  switch (params.shape) {
    case "box":
      return [box(lift, [sx, sy, sz], color)];
    case "cylinder":
      return [{
        type: "cylinder",
        pos: lift,
        quat: IDENTITY,
        size: [Math.max(sx, sy) / 2, sz / 2],
        rgba: color,
        role: "both",
      }];
    case "sphere":
      return [{
        type: "ellipsoid",
        pos: lift,
        quat: IDENTITY,
        size: [sx / 2, sy / 2, sz / 2],
        rgba: color,
        role: "both",
      }];
    case "cone":
      return [{
        type: "mesh",
        pos: [0, 0, 0],
        quat: IDENTITY,
        size: [],
        mesh: coneMesh(Math.max(sx, sy) / 2, sz),
        rgba: color,
        role: "both",
      }];
    case "ramp":
      return [{
        type: "mesh",
        pos: [0, 0, 0],
        quat: IDENTITY,
        size: [],
        mesh: rampMesh(sx, sy, sz),
        rgba: color,
        role: "both",
      }];
    case "bowling_pin":
      return bowlingPinShapes(sx, sy, sz, color);
    case "pipe":
      return pipeShapes(sx, sy, sz, color);
    case "soccer_ball":
      return [{
        type: "sphere",
        pos: [0, 0, Math.max(sx, sy, sz) / 2],
        quat: IDENTITY,
        size: [Math.max(sx, sy, sz) / 2],
        rgba: color,
        role: "both",
      }];
    case "step_stool":
      return stepStoolShapes(sx, sy, sz, color);
    case "ladder":
      return ladderShapes(sx, sy, sz, color);
    case "bucket":
      return bucketShapes(sx, sy, sz, color);
    case "person":
      return personShapes(sx, sy, sz, color);
    case "beanbag":
      return [
        {
          type: "mesh",
          pos: [0, 0, 0],
          quat: IDENTITY,
          size: [],
          mesh: beanbagMesh(sx, sy, sz),
          rgba: color,
          role: "visual",
        },
        {
          type: "ellipsoid",
          pos: [0, 0, sz * 0.45],
          quat: IDENTITY,
          size: [sx * 0.48, sy * 0.48, sz * 0.45],
          rgba: color,
          role: "collision",
        },
      ];
  }
}

/** walls split around door openings; floor slab and ceiling; origin at the room's floor center */
export function roomShapes(p: RoomParams): Shape[] {
  const color = rgba(p.color);
  const t = Math.max(p.wallThickness, 0.02);
  const shapes: Shape[] = [];
  const slab = 0.1;
  if (p.floor) {
    shapes.push(box([0, 0, -slab / 2], [p.width + t, p.depth + t, slab], color));
  }
  if (p.ceiling) {
    shapes.push(box([0, 0, p.height + slab / 2], [p.width + t, p.depth + t, slab], color));
  }
  const walls = [
    { wall: "north", length: p.width + t, center: [0, p.depth / 2], along: [1, 0] },
    { wall: "south", length: p.width + t, center: [0, -p.depth / 2], along: [1, 0] },
    { wall: "east", length: p.depth - t, center: [p.width / 2, 0], along: [0, 1] },
    { wall: "west", length: p.depth - t, center: [-p.width / 2, 0], along: [0, 1] },
  ] as const;
  for (const w of walls) {
    const half = w.length / 2;
    const openings = p.doors
      .filter((d) => d.wall === w.wall)
      .map((d) => {
        const width = Math.min(Math.max(d.width, 0.1), w.length);
        const center = Math.min(Math.max(d.offset, -half + width / 2), half - width / 2);
        const bottom = Math.min(Math.max(d.bottom ?? 0, 0), p.height - 0.05);
        return {
          start: center - width / 2,
          end: center + width / 2,
          bottom,
          top: Math.min(Math.max(d.height, bottom + 0.05), p.height),
        };
      })
      .sort((a, b) => a.start - b.start);
    // full-height pieces between openings; under each opening its sill, over it its lintel
    let cursor = -half;
    const pieces: { start: number; end: number; bottom: number; top: number }[] = [];
    for (const o of openings) {
      if (o.start > cursor) pieces.push({ start: cursor, end: o.start, bottom: 0, top: p.height });
      if (o.bottom > 0) pieces.push({ start: o.start, end: o.end, bottom: 0, top: o.bottom });
      if (o.top < p.height) {
        pieces.push({ start: o.start, end: o.end, bottom: o.top, top: p.height });
      }
      cursor = Math.max(cursor, o.end);
    }
    if (cursor < half) pieces.push({ start: cursor, end: half, bottom: 0, top: p.height });
    for (const piece of pieces) {
      const length = piece.end - piece.start;
      const height = piece.top - piece.bottom;
      if (length < 1e-3 || height < 1e-3) continue;
      const mid = (piece.start + piece.end) / 2;
      const cx = w.center[0] + w.along[0] * mid;
      const cy = w.center[1] + w.along[1] * mid;
      const size: Vec3 = w.along[0] ? [length, t, height] : [t, length, height];
      shapes.push(box([cx, cy, piece.bottom + height / 2], size, color));
    }
  }
  return shapes;
}

/** a ready-made opening of each kind (offset 0, on the given wall) */
export function openingPreset(kind: DoorOpening["kind"], wall: DoorOpening["wall"]): DoorOpening {
  switch (kind) {
    case "double":
      return { wall, kind, offset: 0, width: 1.8, height: 2.1, bottom: 0 };
    case "window":
      return { wall, kind, offset: 0, width: 1.2, height: 2.0, bottom: 0.9 };
    case "crawl":
      return { wall, kind, offset: 0, width: 0.7, height: 0.6, bottom: 0 };
    case "arch":
      return { wall, kind, offset: 0, width: 2.4, height: 2.5, bottom: 0 };
    default:
      return { wall, kind: "door", offset: 0, width: 0.9, height: 2.1, bottom: 0 };
  }
}

/** one straight flight rising along +x from x0 (at height z0), solid or open-riser */
function flight(
  p: StairsParams,
  steps: number,
  x0: number,
  y: number,
  z0: number,
  direction: 1 | -1,
  color: Rgba,
): Shape[] {
  const shapes: Shape[] = [];
  const tread = Math.min(Math.max(p.treadThickness ?? 0.04, 0.01), p.stepHeight * 0.9);
  for (let i = 0; i < steps; i++) {
    const top = z0 + (i + 1) * p.stepHeight;
    const x = x0 + direction * (i + 0.5) * p.stepDepth;
    if (p.openRisers) {
      shapes.push(box([x, y, top - tread / 2], [p.stepDepth + 0.02, p.width, tread], color));
    } else {
      const bottom = z0;
      shapes.push(box([x, y, (top + bottom) / 2], [p.stepDepth, p.width, top - bottom], color));
    }
  }
  const run = steps * p.stepDepth;
  const rise = steps * p.stepHeight;
  const slope = axisAngle([0, 1, 0], -direction * Math.atan2(rise, run));
  const length = Math.hypot(run, rise);
  if (p.openRisers) {
    const depth = Math.min(0.2, p.stepHeight * 1.2);
    for (const side of [1, -1]) {
      shapes.push(rotatedBox(
        [x0 + direction * run / 2, y + side * (p.width / 2 + 0.02), z0 + rise / 2 - depth / 2],
        [length, 0.04, depth],
        slope,
        color,
      ));
    }
  }
  shapes.push(...railings(p, x0, y, z0, direction, run, rise, color));
  return shapes;
}

/** handrails along a flight's sides: posts and a top rail, a solid panel, or posts and three cables */
function railings(
  p: StairsParams,
  x0: number,
  y: number,
  z0: number,
  direction: 1 | -1,
  run: number,
  rise: number,
  color: Rgba,
): Shape[] {
  const which = p.railing ?? "none";
  if (which === "none") return [];
  const sides = which === "both" ? [1, -1] : which === "left" ? [1] : [-1];
  const style = p.railingStyle ?? "posts";
  const height = 0.9;
  const slopeAngle = Math.atan2(rise, run);
  const slope = axisAngle([0, 1, 0], -direction * slopeAngle);
  const length = Math.hypot(run, rise);
  const metal: Rgba = [0.35, 0.36, 0.38, 1];
  const shapes: Shape[] = [];
  for (const side of sides) {
    const ry = y + side * (p.width / 2 + 0.05);
    const at = (fraction: number, lift: number): Vec3 => [
      x0 + direction * run * fraction,
      ry,
      z0 + rise * fraction + lift,
    ];
    if (style === "panel") {
      shapes.push(
        rotatedBox(at(0.5, height / 2 + p.stepHeight / 2), [length, 0.03, height], slope, color),
      );
      continue;
    }
    const posts = Math.max(2, Math.round(run / 0.6) + 1);
    for (let i = 0; i < posts; i++) {
      const f = i / (posts - 1);
      const base = at(f, p.stepHeight);
      shapes.push({
        type: "cylinder",
        pos: [base[0], base[1], base[2] + height / 2],
        quat: IDENTITY,
        size: [0.02, height / 2],
        rgba: metal,
        role: "both",
      });
    }
    const rails = style === "cables" ? [0.3, 0.6, 0.9] : [1];
    for (const r of rails) {
      shapes.push(
        rotatedBox(at(0.5, p.stepHeight + height * r), [length + 0.1, 0.04, 0.04], slope, metal),
      );
    }
  }
  return shapes;
}

/** a landing at height `top`: a solid block down to the floor, or with open risers a slab you can see and step under */
function landingBox(
  p: StairsParams,
  center: [number, number],
  size: [number, number],
  top: number,
  color: Rgba,
): Shape {
  const thick = p.openRisers ? Math.min(0.08, top) : top;
  return box([center[0], center[1], top - thick / 2], [size[0], size[1], thick], color);
}

/** stairs; origin at the bottom of the first step's front edge, centered across */
export function stairsShapes(p: StairsParams): Shape[] {
  const color = rgba(p.color);
  const steps = Math.max(1, Math.round(p.steps));
  const style = p.style ?? "straight";
  if (style === "switchback") {
    // up along +x, a landing, then back along -x beside the first flight
    const first = Math.ceil(steps / 2);
    const second = steps - first;
    const run1 = first * p.stepDepth;
    const landingZ = first * p.stepHeight;
    const gap = 0.1;
    const offset = p.width + gap;
    const landing = p.width;
    const shapes = flight(p, first, 0, 0, 0, 1, color);
    shapes.push(
      landingBox(
        p,
        [run1 + landing / 2, offset / 2],
        [landing, p.width * 2 + gap],
        landingZ,
        color,
      ),
    );
    shapes.push(...flight(p, second, run1, offset, landingZ, -1, color));
    return shapes;
  }
  if (style === "turn") {
    // up along +x, a square landing, then a second flight at 90° (to +y for a left turn, -y for a right one)
    const first = Math.ceil(steps / 2);
    const second = steps - first;
    const run1 = first * p.stepDepth;
    const landingZ = first * p.stepHeight;
    const side = p.turnDirection === "right" ? -1 : 1;
    const shapes = flight(p, first, 0, 0, 0, 1, color);
    shapes.push(landingBox(p, [run1 + p.width / 2, 0], [p.width, p.width], landingZ, color));
    shapes.push(...placeShapes(
      flight(p, second, 0, 0, 0, 1, color),
      side * Math.PI / 2,
      [run1 + p.width / 2, side * p.width / 2, landingZ],
    ));
    return shapes;
  }
  if (style === "spiral") {
    // wedge-like treads around a center post, climbing counterclockwise
    const turn = ((p.spiralTurn ?? 360) * Math.PI) / 180;
    const core = Math.max(0.05, p.spiralCore ?? 0.1);
    const outer = core + p.width;
    const tread = Math.min(Math.max(p.treadThickness ?? 0.05, 0.02), p.stepHeight * 0.9);
    const step = turn / steps;
    const shapes: Shape[] = [{
      type: "cylinder",
      pos: [0, 0, (steps * p.stepHeight + 1) / 2],
      quat: IDENTITY,
      size: [core, (steps * p.stepHeight + 1) / 2],
      rgba: color,
      role: "both",
    }];
    const middle = (core + outer) / 2;
    const chord = 2 * outer * Math.sin(step / 2) * 1.05;
    for (let i = 0; i < steps; i++) {
      const angle = (i + 0.5) * step;
      const top = (i + 1) * p.stepHeight;
      shapes.push(rotatedBox(
        [Math.cos(angle) * middle, Math.sin(angle) * middle, top - tread / 2],
        [outer - core, chord, tread],
        axisAngle([0, 0, 1], angle),
        color,
      ));
      if (p.railing && p.railing !== "none") {
        shapes.push({
          type: "cylinder",
          pos: [Math.cos(angle) * (outer - 0.04), Math.sin(angle) * (outer - 0.04), top + 0.45],
          quat: IDENTITY,
          size: [0.02, 0.45],
          rgba: [0.35, 0.36, 0.38, 1],
          role: "both",
        });
      }
    }
    return shapes;
  }
  return flight(p, steps, 0, 0, 0, 1, color);
}

/** heights in meters on a resolution x resolution grid, rows from -y to +y, columns from -x to +x */
export function hillHeights(p: HillParams): { n: number; heights: Float32Array } {
  const n = Math.max(8, Math.min(256, Math.round(p.resolution)));
  const raw = new Float32Array(n * n);
  let lo = Infinity;
  let hi = -Infinity;
  const scale = p.frequency / 10;
  const bumps = Math.max(0, p.bumps ?? 0);
  const bumpSize = Math.max(0.1, p.bumpSize ?? 0.6);
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const x = (col / (n - 1) - 0.5) * p.sizeX;
      const y = (row / (n - 1) - 0.5) * p.sizeY;
      const v = fbm(
        x * scale + 1000,
        y * scale + 1000,
        Math.max(1, Math.round(p.octaves)),
        p.roughness,
        p.seed,
      );
      raw[row * n + col] = v;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  const heights = new Float32Array(n * n);
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      let h = (hi > lo ? (raw[row * n + col] - lo) / (hi - lo) : 0) * p.amplitude;
      if (bumps > 0) {
        // two octaves of value noise at the bump spacing, in 0..bumps
        const x = (col / (n - 1) - 0.5) * p.sizeX / bumpSize;
        const y = (row / (n - 1) - 0.5) * p.sizeY / bumpSize;
        h += bumps * fbm(x + 5000, y + 5000, 2, 0.35, p.seed + 7919);
      }
      if (p.edgeFade) {
        const edge = Math.min(col, row, n - 1 - col, n - 1 - row) / ((n - 1) * 0.15);
        const fade = Math.min(1, edge);
        h *= fade * fade * (3 - 2 * fade);
      }
      heights[row * n + col] = h;
    }
  }
  return { n, heights };
}

export function hillShapes(p: HillParams): Shape[] {
  const { n, heights } = hillHeights(p);
  const top = Math.max(p.amplitude + Math.max(0, p.bumps ?? 0), 1e-3);
  return [{
    type: "hfield",
    pos: [0, 0, 0],
    quat: IDENTITY,
    size: [],
    hfield: {
      nrow: n,
      ncol: n,
      size: [p.sizeX / 2, p.sizeY / 2, top, 0.1],
      // MuJoCo's (and three's PlaneGeometry's) first row is +y; hillHeights' first row is -y
      elevation: Array.from({ length: n * n }, (_, i) => {
        const row = n - 1 - Math.floor(i / n);
        return heights[row * n + (i % n)] / top;
      }),
    },
    rgba: rgba(p.color),
    role: "both",
  }];
}

function meshShapes(asset: MeshAsset | undefined, scale: Vec3): Shape[] {
  if (!asset) return [];
  const shapes: Shape[] = asset.visuals.map((v) => ({
    type: "mesh" as const,
    pos: [0, 0, 0] as Vec3,
    quat: IDENTITY,
    size: [],
    meshFile: { asset: asset.id, file: v.file, scale },
    rgba: v.rgba,
    role: "visual" as const,
  }));
  for (const hull of asset.hulls) {
    shapes.push({
      type: "mesh",
      pos: [0, 0, 0],
      quat: IDENTITY,
      size: [],
      meshFile: { asset: asset.id, file: hull, scale },
      rgba: [0.9, 0.3, 0.9, 1],
      role: "collision",
    });
  }
  return shapes;
}

export function itemShapes(item: Item, assets: Record<string, MeshAsset>): Shape[] {
  switch (item.kind) {
    case "primitive":
      return primitiveShapes(item.params, item.scale);
    case "room":
      return roomShapes(item.params);
    case "stairs":
      return stairsShapes(item.params);
    case "hill":
      return hillShapes(item.params);
    case "mesh":
      return meshShapes(assets[item.params.asset], item.scale);
    case "hole":
      // the hole is cut out of its floor's slab (floorSlab); the box is only a handle to pick it by in the editor
      return [
        ...grateShapes(item.params),
        box(
          [0, 0, -item.params.depth / 2],
          [item.params.sizeX, item.params.sizeY, item.params.depth],
          [0.9, 0.3, 0.2, 0.18],
          "editor",
        ),
      ];
    case "apriltag":
      return aprilTagShapes(item.params);
    case "image":
      // editor-only: a picture plane (size: half-extents, its y-z face) with no collision and no MuJoCo geom
      return [{
        type: "box",
        pos: [0, 0, 0],
        quat: IDENTITY,
        size: [0, Math.max(item.params.width, 0.01) / 2, Math.max(item.params.height, 0.01) / 2],
        rgba: [1, 1, 1, item.params.opacity ?? 1],
        role: "editor",
        image: {
          src: item.params.src,
          opacity: Math.min(1, Math.max(0, item.params.opacity ?? 1)),
          doubleSided: item.params.doubleSided ?? true,
        },
      }];
    case "light":
      // a bulb to pick it by in the editor; the light itself is in Body.lights
      return [
        ...(item.params.fixture === "can"
          ? [
            cylinderAlong("z", [0, 0, 0.035], 0.1, 0.07, [0.94, 0.94, 0.93, 1], "visual"),
            cylinderAlong("z", [0, 0, -0.002], 0.075, 0.004, [1, 0.97, 0.88, 1], "visual"),
          ]
          : []),
        {
          type: "sphere",
          pos: [0, 0, 0],
          quat: IDENTITY,
          size: [0.12],
          rgba: [...item.params.color, 1] as Rgba,
          role: "editor",
        },
      ];
  }
}

/**
 * the AprilTag printed with its white margin (10 cells around tag36h11's 8-cell black square), facing +x: a thin
 * slab whose front face carries the image (texcoords set so it reads correctly from in front, +y to the right)
 */
export function aprilTagShapes(p: AprilTagParams): Shape[] {
  const h = (p.size * (10 / 8)) / 2;
  const t = 0.002;
  // front corners (x = t) then back corners (x = 0): bottom-left, bottom-right, top-right, top-left as seen from +x
  const vertices = [t, -h, -h, t, h, -h, t, h, h, t, -h, h, 0, -h, -h, 0, h, -h, 0, h, h, 0, -h, h];
  const faces = [
    0,
    1,
    2,
    0,
    2,
    3,
    4,
    6,
    5,
    4,
    7,
    6,
    0,
    4,
    5,
    0,
    5,
    1,
    1,
    5,
    6,
    1,
    6,
    2,
    2,
    6,
    7,
    2,
    7,
    3,
    3,
    7,
    4,
    3,
    4,
    0,
  ];
  const texcoords = [0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0];
  return [{
    type: "mesh",
    pos: [0, 0, 0],
    quat: IDENTITY,
    size: [t / 2, h, h],
    mesh: { vertices, faces, texcoords },
    rgba: [1, 1, 1, 1],
    role: "visual",
    texture: `apriltags/${p.family}_${String(p.id).padStart(5, "0")}.png`,
  }];
}

/** a floor's slab with its holes cut out: boxes over the cells a grid of the hole edges makes; pits keep a bottom */
/** bar centers across a span: as many bars as fit with at least `gap` between them, spaced evenly, edge gaps too */
export function barCenters(span: number, barWidth: number, gap: number): number[] {
  const count = Math.floor((span - gap) / (barWidth + gap));
  if (count < 1) return [];
  const spacing = (span - count * barWidth) / (count + 1);
  return Array.from(
    { length: count },
    (_, i) => -span / 2 + spacing * (i + 1) + barWidth * (i + 0.5),
  );
}

/** a hole's grate: bars whose tops are flush with the floor (z = 0 in the hole's frame), running the hole's length */
export function grateShapes(p: HoleParams): Shape[] {
  const g = p.grate;
  if (!g || g.barWidth <= 0 || g.gap <= 0) return [];
  const depth = Math.max(0.005, Math.min(g.barDepth, p.depth));
  const metal: Rgba = [0.2, 0.21, 0.23, 1];
  const shapes: Shape[] = [];
  const along = (direction: "x" | "y") => {
    // bars running along `direction`, spaced across the other side
    const across = direction === "x" ? p.sizeY : p.sizeX;
    const length = direction === "x" ? p.sizeX : p.sizeY;
    for (const c of barCenters(across, g.barWidth, g.gap)) {
      shapes.push(box(
        direction === "x" ? [0, c, -depth / 2] : [c, 0, -depth / 2],
        direction === "x" ? [length, g.barWidth, depth] : [g.barWidth, length, depth],
        metal,
      ));
    }
  };
  along(g.direction);
  if (g.pattern === "grid") along(g.direction === "x" ? "y" : "x");
  return shapes;
}

export function floorSlab(floor: Floor, holes: Item[], elevation: number): Body | null {
  const slab = floor.slab;
  if (!slab || slab.thickness <= 0) return null;
  const color: Rgba = slab.color ? rgba(slab.color) : [0.26, 0.27, 0.29, 1];
  const x0 = slab.center[0] - slab.sizeX / 2, x1 = slab.center[0] + slab.sizeX / 2;
  const y0 = slab.center[1] - slab.sizeY / 2, y1 = slab.center[1] + slab.sizeY / 2;
  const rects = holes.flatMap((h) =>
    h.kind === "hole"
      ? [{
        x0: Math.max(x0, h.position[0] - h.params.sizeX / 2),
        x1: Math.min(x1, h.position[0] + h.params.sizeX / 2),
        y0: Math.max(y0, h.position[1] - h.params.sizeY / 2),
        y1: Math.min(y1, h.position[1] + h.params.sizeY / 2),
        depth: Math.min(h.params.depth, slab.thickness),
      }]
      : []
  ).filter((r) => r.x1 > r.x0 && r.y1 > r.y0);
  const xs = [...new Set([x0, x1, ...rects.flatMap((r) => [r.x0, r.x1])])].sort((a, b) => a - b);
  const ys = [...new Set([y0, y1, ...rects.flatMap((r) => [r.y0, r.y1])])].sort((a, b) => a - b);
  const shapes: Shape[] = [];
  for (let j = 0; j < ys.length - 1; j++) {
    // the cells of this row, each the depth cut there (0: solid), merged into runs of equal depth
    let run: { start: number; depth: number } | null = null;
    const flush = (end: number) => {
      if (!run) return;
      const top = -run.depth;
      const bottom = -slab.thickness;
      if (top - bottom > 1e-6) {
        shapes.push(box(
          [(run.start + end) / 2, (ys[j] + ys[j + 1]) / 2, (top + bottom) / 2],
          [end - run.start, ys[j + 1] - ys[j], top - bottom],
          color,
        ));
      }
      run = null;
    };
    for (let i = 0; i < xs.length - 1; i++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
      const depth = Math.max(
        0,
        ...rects.filter((r) => cx > r.x0 && cx < r.x1 && cy > r.y0 && cy < r.y1).map((r) =>
          r.depth
        ),
      );
      if (run && run.depth !== depth) flush(xs[i]);
      run ??= { start: xs[i], depth };
    }
    flush(xs[xs.length - 1]);
  }
  return {
    name: `slab_${floor.id.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`,
    label: `${floor.name} slab`,
    kind: "slab",
    itemId: `slab:${floor.id}`,
    floor: floor.id,
    pos: [0, 0, elevation],
    quat: IDENTITY,
    mocap: false,
    shapes: slab.finish && slab.finish !== "plain"
      ? shapes.map((shape) => ({ ...shape, finish: slab.finish as Exclude<FloorFinish, "plain"> }))
      : shapes,
  };
}

export function buildWorld(project: Project, assets: Record<string, MeshAsset>): World {
  const elevation = new Map(project.floors.map((f) => [f.id, f.elevation]));
  const bodies: Body[] = [];
  const movers: WorldMover[] = [];
  for (const item of project.items) {
    const lift = elevation.get(item.floor) ?? 0;
    const name = bodyName(item);
    const mover = item.mover && item.mover.waypoints.length >= 2 && item.mover.speed > 0;
    bodies.push({
      name,
      label: item.name,
      kind: item.kind === "primitive" ? item.params.shape : item.kind,
      itemId: item.id,
      floor: item.floor,
      pos: [item.position[0], item.position[1], item.position[2] + lift],
      quat: item.rotation,
      mocap: Boolean(mover),
      shapes: itemShapes(item, assets),
      lights: item.kind === "light"
        ? [{
          type: item.params.type,
          rgb: item.params.color.map((c) => c * item.params.intensity) as Vec3,
          range: item.params.range,
          angle: item.params.angle,
          shadows: item.params.shadows,
        }]
        : undefined,
    });
    if (mover && item.mover) {
      movers.push({
        body: name,
        waypoints: item.mover.waypoints.map((w) => [w[0], w[1], w[2] + lift] as Vec3),
        speed: item.mover.speed,
        mode: item.mover.mode,
        heading: item.mover.heading,
      });
    }
  }
  let groundZ = 0;
  for (const floor of project.floors) {
    const slab = floorSlab(
      floor,
      project.items.filter((i) => i.kind === "hole" && i.floor === floor.id),
      floor.elevation,
    );
    if (slab) {
      bodies.push(slab);
      if (floor.elevation === Math.min(...project.floors.map((f) => f.elevation))) {
        groundZ = floor.elevation - (floor.slab?.thickness ?? 0);
      }
    }
  }
  const spawns = project.spawns.map((s) => ({
    name: s.name,
    pos: [s.position[0], s.position[1], s.position[2] + (elevation.get(s.floor) ?? 0)] as Vec3,
    yaw: s.yaw,
  }));
  const cameras = (project.views ?? []).map((view) => ({
    name: view.key,
    label: view.name,
    pos: view.eye,
    xyaxes: cameraLookAt(view.eye, view.target),
    fovy: view.fov,
  }));
  return { groundZ, bodies, spawns, movers, cameras };
}

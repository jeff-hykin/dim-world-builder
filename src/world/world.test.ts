import { describe, expect, it } from "vitest";
import {
  aprilTagShapes,
  buildWorld,
  floorSlab,
  hillHeights,
  hillShapes,
  openingPreset,
  roomShapes,
  stairsShapes,
} from "./geometry.ts";
import { toScene } from "./mjcf.ts";
import { moverPose } from "./movers.ts";
import type { Vec3 } from "./types.ts";
import {
  defaultHill,
  defaultLight,
  defaultRoom,
  defaultStairs,
  emptyProject,
  makeItem,
} from "./defaults.ts";
import { testCourse } from "./examples.ts";
import { keyedProject } from "./keys.ts";
import { barCenters, grateShapes } from "./geometry.ts";
import { defaultGrate } from "./defaults.ts";
import { climbing, coveringSlab, openingAbove } from "./stairs_fit.ts";
import { exportAnnotations, withAnnotations } from "./annotations.ts";
import { cameraLookAt } from "./geometry.ts";

describe("rooms", () => {
  it("leaves a gap the door's width in its wall", () => {
    const room = {
      ...defaultRoom(),
      width: 6,
      depth: 4,
      doors: [{ wall: "south" as const, offset: 0, width: 1.2, height: 2 }],
    };
    const south = roomShapes(room).filter((s) => Math.abs(s.pos[1] + 2) < 1e-6);
    // two full-height pieces beside the door and a lintel over it
    expect(south).toHaveLength(3);
    const full = south.filter((s) => s.pos[2] === room.height / 2);
    const gap = Math.min(...full.map((s) => Math.abs(s.pos[0]) - s.size[0]));
    expect(gap * 2).toBeCloseTo(1.2, 5);
  });
  it("adds a ceiling only when asked", () => {
    const top = (ceiling: boolean) =>
      roomShapes({ ...defaultRoom(), ceiling }).filter((s) => s.pos[2] > defaultRoom().height);
    expect(top(true)).toHaveLength(1);
    expect(top(false)).toHaveLength(0);
  });
});

describe("stairs", () => {
  it("rises step height per step, solid by default", () => {
    const stairs = stairsShapes({ ...defaultStairs(), steps: 4, stepHeight: 0.2 });
    const tops = stairs.map((s) => s.pos[2] + s.size[2]);
    expect(tops.map((t) => Number(t.toFixed(6)))).toEqual([0.2, 0.4, 0.6, 0.8]);
  });
  it("open risers: thin treads with gaps under them, plus two stringers", () => {
    const stairs = stairsShapes({
      ...defaultStairs(),
      steps: 4,
      stepHeight: 0.2,
      openRisers: true,
      treadThickness: 0.04,
    });
    const treads = stairs.filter((s) => s.quat[3] === 1);
    expect(treads).toHaveLength(4);
    treads.forEach((t) => expect(t.size[2] * 2).toBeCloseTo(0.04, 6));
    expect(stairs.length - treads.length).toBe(2);
  });
});

describe("hills", () => {
  it("spans exactly 0..amplitude and meets the ground at the edges", () => {
    const hill = { ...defaultHill(), amplitude: 0.8, bumps: 0, resolution: 32, edgeFade: true };
    const { n, heights } = hillHeights(hill);
    expect(Math.max(...heights)).toBeLessThanOrEqual(0.8 + 1e-6);
    expect(Math.max(...heights)).toBeGreaterThan(0.3);
    expect(heights[0]).toBeCloseTo(0);
    expect(heights[n * n - 1]).toBeCloseTo(0);
  });
  it("writes MuJoCo's row order (first row is +y)", () => {
    const hill = { ...defaultHill(), resolution: 16, edgeFade: false };
    const { n, heights } = hillHeights(hill);
    const shape = hillShapes(hill)[0];
    const top = shape.hfield!.size[2];
    // last computed row (+y) is the first written row
    expect(shape.hfield!.elevation[0] * top).toBeCloseTo(heights[(n - 1) * n], 5);
  });
  it("adds small bumps a robot feels, still walkable", () => {
    const smooth = { ...defaultHill(), bumps: 0 };
    const bumpy = defaultHill();
    const a = hillHeights(smooth);
    const b = hillHeights(bumpy);
    const cell = bumpy.sizeX / (b.n - 1);
    let biggest = 0;
    let steepest = 0;
    for (let i = 0; i < b.heights.length; i++) {
      biggest = Math.max(biggest, b.heights[i] - a.heights[i]);
      if (i % b.n < b.n - 1) {
        steepest = Math.max(steepest, Math.abs(b.heights[i + 1] - b.heights[i]) / cell);
      }
    }
    expect(biggest).toBeGreaterThan(0.05);
    expect(biggest).toBeLessThanOrEqual(bumpy.bumps! + 1e-6);
    // slope in degrees, cell to cell
    expect((Math.atan(steepest) * 180) / Math.PI).toBeLessThan(35);
  });
  it("is the same for the same seed", () => {
    expect(hillHeights(defaultHill()).heights).toEqual(hillHeights(defaultHill()).heights);
  });
});

describe("export", () => {
  it("names every body as a scene entity, hides collision-only geometry, and lists movers", () => {
    const world = buildWorld(testCourse(), {});
    const scene = toScene(world, "course");
    const json = scene.sceneJson as {
      entities: Record<string, unknown>;
      spawns: Record<string, unknown>;
      hidden_geom_groups: number[];
      movers: unknown[];
    };
    expect(Object.keys(json.entities)).toHaveLength(world.bodies.length);
    expect(json.spawns.default).toBeDefined();
    expect(json.hidden_geom_groups).toEqual([3]);
    expect(json.movers).toHaveLength(1);
    expect(scene.xml).toContain('mocap="true"');
    expect(scene.xml).toContain("<hfield name=");
    expect(scene.xml).toContain('type="skybox"');
  });
});

describe("openings, holes, stairs styles, tags", () => {
  it("a window keeps wall under its sill and over its top", () => {
    const room = {
      ...defaultRoom(),
      width: 6,
      depth: 4,
      height: 2.8,
      doors: [openingPreset("window", "south")],
    };
    const south = roomShapes(room).filter((s) => Math.abs(s.pos[1] + 2) < 1e-6);
    const under = south.filter((s) =>
      s.pos[2] - s.size[2] < 1e-6 && s.pos[2] + s.size[2] <= 0.9 + 1e-6
    );
    expect(under).toHaveLength(1);
    expect(south.some((s) => Math.abs(s.pos[2] - s.size[2] - 2.0) < 1e-6)).toBe(true);
  });
  it("a hole cuts its floor's slab, a pit keeps a bottom", () => {
    const floor = {
      id: "g",
      name: "g",
      elevation: 0,
      slab: { thickness: 1, sizeX: 10, sizeY: 10, center: [0, 0] as [number, number] },
    };
    const hole = (depth: number) =>
      makeItem("hole", { sizeX: 2, sizeY: 2, depth }, { name: "h", floor: "g" });
    const covered = (depth: number) => {
      const slab = floorSlab(floor, [hole(depth)], 0)!;
      // the column of slab over the hole's center: its top
      const over = slab.shapes.filter((s) =>
        Math.abs(s.pos[0]) < s.size[0] && Math.abs(s.pos[1]) < s.size[1]
      );
      return over.map((s) => s.pos[2] + s.size[2]);
    };
    expect(covered(0.4).map((v) => Number(v.toFixed(6)))).toEqual([-0.4]);
    expect(covered(2)).toEqual([]);
  });
  it("spiral stairs: one tread per step around a post", () => {
    const spiral = stairsShapes({ ...defaultStairs(), style: "spiral", steps: 12 });
    expect(spiral.filter((s) => s.type === "box")).toHaveLength(12);
  });
  it("switchback stairs: both flights and a landing reach the full rise", () => {
    const s = stairsShapes({ ...defaultStairs(), style: "switchback", steps: 10, stepHeight: 0.2 });
    expect(Math.max(...s.map((b) => b.pos[2] + b.size[2]))).toBeCloseTo(2.0, 5);
  });
  it("90° turn stairs: the second flight runs off the landing's side and reaches the full rise", () => {
    const p = {
      ...defaultStairs(),
      style: "turn" as const,
      steps: 10,
      stepHeight: 0.2,
      stepDepth: 0.3,
      width: 1,
    };
    const left = stairsShapes(p);
    expect(Math.max(...left.map((b) => b.pos[2] + b.size[2]))).toBeCloseTo(2.0, 5);
    // the last tread sits beside the landing (x 1.5..2.5), up along +y for a left turn and -y for a right one
    const top = (shapes: typeof left) =>
      shapes.reduce((a, b) => (b.pos[2] + b.size[2] > a.pos[2] + a.size[2] ? b : a));
    expect(top(left).pos[0]).toBeCloseTo(2.0, 5);
    expect(top(left).pos[1]).toBeGreaterThan(1.5);
    expect(top(stairsShapes({ ...p, turnDirection: "right" })).pos[1]).toBeLessThan(-1.5);
  });
  it("an AprilTag is printed 10/8 its black square, with texcoords for its image", () => {
    const [tag] = aprilTagShapes({ family: "tag36h11", id: 7, size: 0.1 });
    expect(tag.size[1] * 2).toBeCloseTo(0.125, 6);
    expect(tag.texture).toBe("apriltags/tag36h11_00007.png");
    expect(tag.mesh?.texcoords).toHaveLength(16);
  });
});

it("a light item exports as a MuJoCo light on its body, with no geoms", () => {
  const project = emptyProject("lit");
  project.items = [
    makeItem("light", { ...defaultLight(), type: "spot", shadows: true }, {
      name: "Lamp",
      floor: project.floors[0].id,
      position: [1, 2, 2.5],
    }),
  ];
  const { xml } = toScene(buildWorld(project, {}), "lit");
  const lamp = xml.match(/<body name="lamp[^"]*"[\s\S]*?<\/body>/)![0];
  expect(lamp).toMatch(/<light [^>]*cutoff="40"[^>]*\/>/);
  expect(lamp).toMatch(/castshadow="true"/);
  expect(lamp).not.toMatch(/<geom/);
});

describe("remembered views", () => {
  it("export as fixed MuJoCo cameras named by key, looking at their target", () => {
    const project = emptyProject("views");
    project.views = [{ key: "front", name: "Front", eye: [0, -5, 2], target: [0, 0, 2], fov: 45 }];
    const { xml, viewsJson } = toScene(buildWorld(project, {}), "views");
    // looking down +y: right is +x, up is +z
    expect(xml).toContain('<camera name="front" pos="0 -5 2" xyaxes="1 0 0 0 0 1" fovy="45"/>');
    expect((viewsJson as { views: { camera: string }[] }).views.map((v) => v.camera)).toEqual([
      "front",
    ]);
  });
  it("looks straight down without a degenerate frame", () => {
    const axes = cameraLookAt([0, 0, 10], [0, 0, 0]);
    expect(axes.every(Number.isFinite)).toBe(true);
    expect(Math.hypot(axes[0], axes[1], axes[2])).toBeCloseTo(1);
  });
  it("get unique readable keys", () => {
    const project = emptyProject("views");
    project.views = [
      { key: "", name: "Kitchen view", eye: [0, 0, 1], target: [1, 0, 1], fov: 50 },
      { key: "", name: "Kitchen view", eye: [0, 0, 1], target: [1, 0, 1], fov: 50 },
      { key: "", name: "2nd floor", eye: [0, 0, 1], target: [1, 0, 1], fov: 50 },
    ];
    expect(keyedProject(project).views!.map((v) => v.key)).toEqual([
      "kitchen_view",
      "kitchen_view_2",
      "view_2nd_floor",
    ]);
  });
});

describe("drain grates", () => {
  const openings = (centers: number[], span: number, width: number) => {
    const edges = [-span / 2, ...centers.flatMap((c) => [c - width / 2, c + width / 2]), span / 2];
    return Array.from({ length: edges.length / 2 }, (_, i) => edges[2 * i + 1] - edges[2 * i]);
  };
  it("spaces bars evenly, every opening (edges too) at least the gap", () => {
    const centers = barCenters(1.0, 0.03, 0.04);
    expect(centers.length).toBe(13); // floor((1.0 - 0.04) / (0.03 + 0.04))
    const gaps = openings(centers, 1.0, 0.03);
    gaps.forEach((g) => expect(g).toBeGreaterThanOrEqual(0.04 - 1e-9));
    gaps.forEach((g) => expect(g).toBeCloseTo(gaps[0], 9));
    expect(centers[0]).toBeCloseTo(-centers[centers.length - 1], 9);
  });
  it("has no bars when none fit", () => {
    expect(barCenters(0.05, 0.03, 0.04)).toEqual([]);
  });
  it("makes slats one way and a grid both ways, tops flush with the floor, as collision boxes", () => {
    const hole = {
      sizeX: 0.6,
      sizeY: 1.2,
      depth: 0.5,
      grate: { ...defaultGrate(), direction: "y" as const },
    };
    const slats = grateShapes(hole);
    expect(slats.length).toBe(barCenters(0.6, 0.03, 0.04).length);
    slats.forEach((bar) => {
      expect(bar.role).toBe("both");
      expect(bar.size[1] * 2).toBeCloseTo(1.2); // running along y, the hole's full length
      expect(bar.pos[2] + bar.size[2]).toBeCloseTo(0); // top at the floor
    });
    const grid = grateShapes({ ...hole, grate: { ...hole.grate, pattern: "grid" } });
    expect(grid.length).toBe(
      barCenters(0.6, 0.03, 0.04).length + barCenters(1.2, 0.03, 0.04).length,
    );
  });
  it("never goes deeper than the hole", () => {
    const [bar] = grateShapes({
      sizeX: 1,
      sizeY: 1,
      depth: 0.02,
      grate: { ...defaultGrate(), barDepth: 0.1 },
    });
    expect(bar.size[2] * 2).toBeCloseTo(0.02);
  });
});

describe("hill look in the export", () => {
  it("gives a hill the speckled grass material, keeping its heights", () => {
    const project = emptyProject("grass");
    project.items = [
      makeItem("hill", defaultHill(), {
        name: "Hill",
        floor: project.floors[0].id,
        position: [0, 0, 0],
      }),
    ];
    const world = buildWorld(project, {});
    const { xml } = toScene(world, "grass");
    expect(xml).toMatch(/<texture name="grass_0" type="2d" builtin="flat"[^>]*mark="random"/);
    expect(xml).toMatch(/type="hfield" hfield="[^"]+" material="grass_0"/);
    const shape = world.bodies.flatMap((b) => b.shapes).find((s) => s.type === "hfield")!;
    expect(xml).toContain(
      `elevation="${
        shape.hfield!.elevation.map((v) => String(Math.round(v * 1e6) / 1e6)).join(" ")
      }"`,
    );
  });
});

describe("moverPose", () => {
  const mover = {
    body: "cart",
    waypoints: [[0, 0, 0], [4, 0, 0], [4, 3, 0]] as Vec3[],
    speed: 1,
    mode: "loop" as const,
    heading: "path" as const,
  };
  it("walks the path at its speed and loops back to the start", () => {
    expect(moverPose(mover, 2)!.position).toEqual([2, 0, 0]);
    expect(moverPose(mover, 5.5)!.position[1]).toBeCloseTo(1.5);
    expect(moverPose(mover, 12)!.position).toEqual([0, 0, 0]);
  });
  it("faces its direction of travel; pingpong retraces", () => {
    const q = moverPose(mover, 5)!.quat!;
    expect(2 * Math.atan2(q[2], q[3])).toBeCloseTo(Math.PI / 2);
    const back = moverPose({ ...mover, mode: "pingpong" }, 9)!.position;
    expect(back[0]).toBeCloseTo(4);
    expect(back[1]).toBeCloseTo(1);
  });
});

describe("stairs between floors", () => {
  it("climb the whole rise in equal steps no taller than 19 cm", () => {
    const p = climbing({ ...defaultStairs() }, 3);
    expect(p.steps).toBe(16);
    expect(p.steps * p.stepHeight).toBeCloseTo(3, 3);
  });
  it("cut an opening in the floor above that covers their footprint", () => {
    const stairs = makeItem("stairs", climbing(defaultStairs(), 3), {
      name: "Stairs",
      floor: "ground",
      position: [1, 2, 0],
    });
    const above = {
      id: "up",
      name: "Up",
      elevation: 3,
      slab: { thickness: 0.2, sizeX: 20, sizeY: 20, center: [0, 0] as [number, number] },
    };
    const hole = openingAbove(stairs, above);
    expect(hole.floor).toBe("up");
    expect(hole.params.depth).toBe(0.2);
    // a straight flight runs along +x from its origin: 16 steps of 0.3 m
    expect(hole.position[0]).toBeCloseTo(1 + 4.8 / 2, 1);
    expect(hole.params.sizeX).toBeGreaterThanOrEqual(4.8);
    expect(hole.params.sizeY).toBeGreaterThanOrEqual(1.2);
  });
});

describe("annotations", () => {
  it("an old nav test becomes a nav:mapping path and nav:goal points, written in world coordinates", () => {
    const project = testCourse();
    expect(project.nav).toBeDefined();
    const migrated = withAnnotations(project);
    expect(migrated.nav).toBeUndefined();
    const path = migrated.annotations!.find((a) => a.tags.includes("nav:mapping"))!;
    expect(path.kind).toBe("path");
    expect(path.points!.length).toBe(project.nav!.mappingPath.length);
    expect(migrated.annotations!.filter((a) => a.tags.includes("nav:goal")).length).toBe(
      project.nav!.goals.length,
    );
    const out = exportAnnotations(project);
    expect(out[0]).toMatchObject({ id: "nav_mapping", kind: "path", frame: "world" });
    expect(
      out.filter((a) => (a.tags as string[]).includes("nav:goal")).every((a) =>
        Array.isArray(a.position)
      ),
    ).toBe(true);
  });
});

describe("the floor above stairs", () => {
  it("grows (never shrinks) to cover the stairs' opening and a margin", () => {
    const slab = { thickness: 0.2, sizeX: 4, sizeY: 4, center: [0, 0] as [number, number] };
    const hole = makeItem("hole", { sizeX: 2, sizeY: 1, depth: 0.2 }, {
      name: "h",
      floor: "up",
      position: [3, 0, 0],
    });
    const grown = coveringSlab(slab, hole, 1);
    expect(grown.center[0] - grown.sizeX / 2).toBeCloseTo(-2);
    expect(grown.center[0] + grown.sizeX / 2).toBeCloseTo(5);
    expect(grown.sizeY).toBeCloseTo(4);
  });
});

describe("image items", () => {
  it("are an editor-only picture plane: no geom in scene.xml", () => {
    const project = emptyProject("photo");
    project.items.push({
      id: "img1",
      name: "Photo",
      floor: project.activeFloor,
      position: [1, 0, 0.6],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      kind: "image",
      params: { src: "files/images/x.jpg", width: 1.6, height: 1.2 },
    });
    const world = buildWorld(project, {});
    const body = world.bodies.find((b) => b.itemId === "img1")!;
    expect(body.shapes.map((s) => s.role)).toEqual(["editor"]);
    expect(body.shapes[0].size).toEqual([0, 0.8, 0.6]);
    expect(body.shapes[0].image).toEqual({
      src: "files/images/x.jpg",
      opacity: 1,
      doubleSided: true,
    });
    expect(toScene(world, "photo").xml).not.toMatch(/<geom[^>]*photo/i);
  });
});

describe("mergeEdits", () => {
  it("keeps an API change to items the page didn't touch, and takes the page's own edits", async () => {
    const { mergeEdits } = await import("./merge.ts");
    const base = emptyProject("m");
    const item = (id: string, x: number) => ({
      ...makeItem("primitive", { shape: "box", color: [1, 1, 1] }, {
        name: id,
        floor: "ground",
        position: [x, 0, 0] as Vec3,
      }),
      id,
      key: id,
    });
    base.items = [item("a", 0), item("b", 0), item("c", 0)];
    // the API moved a and b; the page (from base) moved b, removed c and added d
    const current = { ...base, items: [item("a", 5), item("b", 5), item("c", 0)] };
    const page = { ...base, name: "m", items: [item("a", 0), item("b", 9), item("d", 1)] };
    const merged = mergeEdits(base, page, current);
    expect(merged.items.map((i) => [i.id, i.position[0]])).toEqual([["a", 5], ["b", 9], ["d", 1]]);
  });
});

// The editor's document: what the person authored. Pure data (JSON), shared by the page and the server.
// World frame: meters, Z up (MuJoCo / ROS). Rotations are unit quaternions [x, y, z, w].

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type Rgb = [number, number, number];

export type FloorFinish = "plain" | "concrete" | "wood" | "tile" | "carpet";

export interface Floor {
  id: string;
  name: string;
  /** height of this floor's ground above the world ground */
  elevation: number;
  /**
   * a solid slab under this floor (its top at the floor's elevation) that holes cut into; the ground floor has a
   * thick one by default so a hole can be a pit
   */
  slab?: {
    thickness: number;
    sizeX: number;
    sizeY: number;
    center: [number, number];
    /** its top's color (default a dark gray) */
    color?: Rgb;
    /** how its top looks in the views: plain color (default), sealed concrete, wood planks, tile or carpet */
    finish?: FloorFinish;
  };
}

export type OpeningKind = "door" | "double" | "window" | "crawl" | "arch";

/** a gap cut through a room's wall: a door (from the floor), a window (from a sill), a crawl-space hatch... */
export interface DoorOpening {
  wall: "north" | "south" | "east" | "west";
  /** along the wall from its center, meters */
  offset: number;
  width: number;
  /** top of the opening above the floor */
  height: number;
  /** bottom of the opening above the floor (a window's sill); 0 for doors */
  bottom?: number;
  kind?: OpeningKind;
}

export interface RoomParams {
  width: number;
  depth: number;
  height: number;
  wallThickness: number;
  floor: boolean;
  ceiling: boolean;
  doors: DoorOpening[];
  color: Rgb;
}

export interface StairsParams {
  steps: number;
  stepHeight: number;
  stepDepth: number;
  width: number;
  /** thin treads with open gaps between them (no risers, like a ship's ladder) instead of solid blocks */
  openRisers?: boolean;
  treadThickness?: number;
  /**
   * straight; switchback: two flights back and forth with a landing; turn: two flights with a landing between them,
   * the second at 90°; spiral: around a center post
   */
  style?: "straight" | "switchback" | "turn" | "spiral";
  /** turn: which way the second flight goes */
  turnDirection?: "left" | "right";
  /** spiral: degrees turned over the whole climb */
  spiralTurn?: number;
  /** spiral: the center post's radius */
  spiralCore?: number;
  railing?: "none" | "left" | "right" | "both";
  railingStyle?: "posts" | "panel" | "cables";
  color: Rgb;
}

export interface HoleParams {
  sizeX: number;
  sizeY: number;
  /** how far down it goes; at least the slab's thickness cuts all the way through */
  depth: number;
  /** a drain grate over the hole: bars flush with the floor's top */
  grate?: GrateParams;
}

/** a storm-drain grate: parallel slats, or a grid of bars both ways; every bar is a collision box */
export interface GrateParams {
  pattern: "slats" | "grid";
  /** slats run along x or along y (a grid has both) */
  direction: "x" | "y";
  /** each bar's width across, meters */
  barWidth: number;
  /** the opening between bars, meters */
  gap: number;
  /** how deep each bar goes below the floor's top, meters */
  barDepth: number;
}

/** a light for the simulation's cameras (and the editor's view): lidar doesn't see light */
export interface LightParams {
  type: "point" | "spot" | "sun";
  color: Rgb;
  /** 0..2, 1 is a bright room light */
  intensity: number;
  /** point/spot: meters until it has faded to about a fifth */
  range: number;
  /** spot: half-angle of the cone, degrees */
  angle: number;
  shadows: boolean;
  /** what it looks like: a bare bulb (editor only) or a recessed can whose face is at the light, its trim above */
  fixture?: "bulb" | "can";
}

export interface AprilTagParams {
  family: "tag36h11";
  id: number;
  /** the black square's edge, meters (what detectors take as tag_size) */
  size: number;
}

/** a photo on a plane, for reference only: never collides, never exported to the sim, skipped by the clip check */
export interface ImageParams {
  /** a URL this app serves (POST api/images returns it), e.g. files/images/<id>.jpg */
  src: string;
  /** meters along the item's local y */
  width: number;
  /** meters along the item's local z */
  height: number;
  /** 0..1 (default 1) */
  opacity?: number;
  /** seen from behind too (default true) */
  doubleSided?: boolean;
}

export interface HillParams {
  sizeX: number;
  sizeY: number;
  /** tallest bump, meters */
  amplitude: number;
  /** how much the finer octaves add, 0..1 */
  roughness: number;
  /** bumps per 10 m at the coarsest octave */
  frequency: number;
  octaves: number;
  seed: number;
  /** grid points per side */
  resolution: number;
  /** fade to zero height at the edges so the hill meets the ground */
  edgeFade: boolean;
  /** small bumps a robot's feet feel, on top of the hill's shape: their height, meters (0 or unset: none) */
  bumps?: number;
  /** typical distance between those bumps, meters */
  bumpSize?: number;
  color: Rgb;
}

export interface PrimitiveParams {
  shape:
    | "box"
    | "cylinder"
    | "sphere"
    | "cone"
    | "ramp"
    | "beanbag"
    | "bowling_pin"
    | "pipe"
    | "soccer_ball"
    | "step_stool"
    | "ladder"
    | "bucket"
    | "person";
  color: Rgb;
}

export interface MeshParams {
  /** library asset id, or a cooked import id */
  source: "library" | "import";
  asset: string;
}

export interface MoverPath {
  /** world-frame points (z included); the item rides from one to the next */
  waypoints: Vec3[];
  speed: number;
  mode: "loop" | "pingpong";
  heading: "path" | "fixed";
}

interface ItemBase {
  id: string;
  /** the readable, unique id ("bed_2"): the entity name in the exported scene; see world/keys.ts */
  key?: string;
  name: string;
  floor: string;
  /** relative to the floor's elevation */
  position: Vec3;
  rotation: Quat;
  /** full extents for primitives, a multiplier for meshes; ignored by generators (they have params) */
  scale: Vec3;
  mover?: MoverPath;
  /** the group it belongs to (Project.groups): its members are selected, moved and turned together */
  group?: string;
}

/** items bundled to move as one (the members carry its id; the export still writes each member) */
export interface ItemGroup {
  id: string;
  name: string;
}

export type Item =
  | (ItemBase & { kind: "primitive"; params: PrimitiveParams })
  | (ItemBase & { kind: "mesh"; params: MeshParams })
  | (ItemBase & { kind: "room"; params: RoomParams })
  | (ItemBase & { kind: "stairs"; params: StairsParams })
  | (ItemBase & { kind: "hill"; params: HillParams })
  | (ItemBase & { kind: "hole"; params: HoleParams })
  | (ItemBase & { kind: "apriltag"; params: AprilTagParams })
  | (ItemBase & { kind: "light"; params: LightParams })
  // lies in the local y-z plane centered on position, facing local +x
  | (ItemBase & { kind: "image"; params: ImageParams });

export type ItemKind = Item["kind"];

export interface Spawn {
  name: string;
  floor: string;
  position: Vec3;
  yaw: number;
}

/** a place the navigation stack is asked to reach */
export interface NavGoal {
  id: string;
  name: string;
  floor: string;
  position: Vec3;
  /** reached when the robot's base is within this many meters (in x, y) */
  tolerance: number;
  /** seconds before the goal counts as failed */
  timeout: number;
}

/**
 * A navigation test: first the robot is driven along `mappingPath` (so the stack builds its map), then each goal is
 * sent to the nav stack in turn. Robot- and stack-agnostic: the runner speaks plain Twist / odometry / PoseStamped.
 */
export interface NavPlan {
  /** the spawn the robot starts at */
  startSpawn: string;
  floor: string;
  /** floor-relative points the robot is driven through before any goal */
  mappingPath: Vec3[];
  goals: NavGoal[];
}

/**
 * A labeled point, path or area on a floor, for tests and tools to read (exported as scene.json `annotations`). A nav
 * test is a path tagged nav:mapping and points tagged nav:goal; other tests use other tags.
 */
export interface Annotation {
  id: string;
  kind: "point" | "path" | "area";
  label: string;
  tags: string[];
  floor: string;
  /** point: floor-relative position and heading (radians) */
  position?: Vec3;
  yaw?: number;
  /** path: the waypoints in order; area: its outline on the floor (floor-relative) */
  points?: Vec3[];
  /** area: how tall the region is above its floor */
  height?: number;
  /** free-form extras (a nav goal's tolerance, timeout and order; a mapping walk's start spawn) */
  props?: Record<string, unknown>;
}

export interface Project {
  format: "dim-world-builder.project.v1";
  name: string;
  floors: Floor[];
  items: Item[];
  spawns: Spawn[];
  /** the floor the editor adds to */
  activeFloor: string;
  /** labeled points, paths and areas */
  annotations?: Annotation[];
  /** the old navigation test (projects before annotations); loading turns it into annotations */
  nav?: NavPlan;
  /** remembered camera views, for people and agents to look from again (exported as MuJoCo cameras) */
  views?: CameraView[];
  groups?: ItemGroup[];
}

/** a remembered camera: where it looks from and at; `key` is its readable id and its MuJoCo camera's name */
export interface CameraView {
  key: string;
  name: string;
  /** world coordinates, meters */
  eye: Vec3;
  target: Vec3;
  /** vertical field of view, degrees */
  fov: number;
}

/** A mesh the page and the exporter both know: a library asset or a cooked import. */
export interface MeshAsset {
  id: string;
  name: string;
  category: string;
  /** natural size in meters (bounding box), before the item's scale */
  size: Vec3;
  /** where its files live, relative to the app: visual.glb, meta.json, visual_*.obj, hull_*.obj */
  base: string;
  visuals: { file: string; rgba: [number, number, number, number] }[];
  hulls: string[];
  license?: string;
  source?: string;
}

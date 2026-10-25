// The editor's state: the project (with undo), the selection, the tool. A tiny external store so the 3D view (outside
// React's render) and the panels read the same thing.

import { useSyncExternalStore } from "react";
import { emptyProject, newId, randomHex } from "../world/defaults.ts";
import type {
  Annotation,
  CameraView,
  Floor,
  Item,
  MoverPath,
  Project,
  Vec3,
} from "../world/types.ts";
import { keyedProject, slug, withKeys, withViewKeys } from "../world/keys.ts";
import { NAV_GOAL, NAV_MAPPING, withAnnotations } from "../world/annotations.ts";

/** extend: scale one side, the opposite face stays put */
export type Gizmo = "translate" | "rotate" | "scale" | "extend";
export type Mode = "edit" | "view";

export interface Fancy {
  on: boolean;
  grass: boolean;
  /** soft, wide sun shadows (VSM); off: cheap hard ones */
  shadows: boolean;
  /** baked floor ambient occlusion */
  occlusion: boolean;
  /** wood grain, weave, brushed metal, concrete and other surface shaders */
  detail: boolean;
  sky: boolean;
  /** the viewer chose (so a software renderer doesn't override it) */
  chosen?: boolean;
}

const FANCY_KEY = "dim-world-builder.fancy";

function loadFancy(): Fancy {
  const all: Fancy = {
    on: true,
    grass: true,
    shadows: true,
    occlusion: true,
    detail: true,
    sky: true,
  };
  try {
    return { ...all, ...JSON.parse(localStorage.getItem(FANCY_KEY) ?? "{}") };
  } catch {
    return all;
  }
}

export interface EditorState {
  project: Project;
  /** the item the inspector and the gizmo are on (the last one clicked) */
  selected: string | null;
  /** everything selected (Shift-click adds; a group's members come together), `selected` among them */
  selection: string[];
  gizmo: Gizmo;
  mode: Mode;
  snap: boolean;
  showCollision: boolean;
  /** the costly eye candy (grass, soft shadows, floor occlusion, surface detail, sky), each switchable; per viewer */
  fancy: Fancy;
  /** play the moving objects along their paths in the editor, as the simulation will */
  previewMotion: boolean;
  /** the item whose mover path clicks on the ground extend */
  drawingPath: string | null;
  /** clicks place a labeled point, extend a labeled path or area, or stick an AprilTag on a wall */
  navTool: "point" | "path" | "area" | "tag" | null;
  /** the path or area the clicks extend (null: the next click starts a new one) */
  labelTarget: string | null;
  /** the tags a new label gets (a nav test preset: nav:mapping, nav:goal) */
  labelTags: string[];
  /** the label open in the Labels tab */
  selectedLabel: string | null;
  past: Project[];
  future: Project[];
  /** the last time the project changed, for autosave */
  revision: number;
  /** counts opened projects (not edits), so the view frames each newly opened world once */
  opened: number;
}

let state: EditorState = {
  project: emptyProject(),
  selected: null,
  selection: [],
  gizmo: "translate",
  mode: "edit",
  snap: false,
  showCollision: false,
  fancy: loadFancy(),
  previewMotion: false,
  drawingPath: null,
  navTool: null,
  labelTarget: null,
  labelTags: [],
  selectedLabel: null,
  past: [],
  future: [],
  revision: 0,
  opened: 0,
};
const listeners = new Set<() => void>();

export function getState(): EditorState {
  return state;
}

function set(next: Partial<EditorState>) {
  // a plain change of `selected` selects just that one
  if ("selected" in next && !("selection" in next)) {
    next = { ...next, selection: next.selected ? [next.selected] : [] };
  }
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useEditor<T>(pick: (s: EditorState) => T): T {
  return useSyncExternalStore(subscribe, () => pick(state));
}

// ── project edits (each one undoable; `coalesce` merges a drag's many updates into one undo step) ──

let coalesceKey: string | null = null;

export function edit(change: (project: Project) => Project, coalesce?: string) {
  const next = change(state.project);
  if (next === state.project) return;
  const past = coalesce && coalesce === coalesceKey
    ? state.past
    : [...state.past.slice(-99), state.project];
  coalesceKey = coalesce ?? null;
  set({ project: next, past, future: [], revision: state.revision + 1 });
}

export function undo() {
  const previous = state.past.at(-1);
  if (!previous) return;
  coalesceKey = null;
  set({
    project: previous,
    past: state.past.slice(0, -1),
    future: [state.project, ...state.future],
    revision: state.revision + 1,
  });
}

export function redo() {
  const next = state.future[0];
  if (!next) return;
  coalesceKey = null;
  set({
    project: next,
    past: [...state.past, state.project],
    future: state.future.slice(1),
    revision: state.revision + 1,
  });
}

export function loadProject(loaded: Project) {
  coalesceKey = null;
  const project = withAnnotations(keyedProject(loaded));
  set({
    project,
    selected: null,
    past: [],
    future: [],
    drawingPath: null,
    revision: state.revision + 1,
  });
}

/**
 * Selects an item: with `add` (Shift-click) it joins (or leaves) the selection; a group's member brings its whole
 * group, unless `member` (Alt-click: just that one, to edit it on its own).
 */
export function select(selected: string | null, how: { add?: boolean; member?: boolean } = {}) {
  const item = state.project.items.find((i) => i.id === selected);
  const ids = item?.group && !how.member
    ? state.project.items.filter((i) => i.group === item.group).map((i) => i.id)
    : selected
    ? [selected]
    : [];
  if (how.add && selected) {
    const already = state.selection.includes(selected);
    const selection = already
      ? state.selection.filter((id) => !ids.includes(id))
      : [...state.selection, ...ids.filter((id) => !state.selection.includes(id))];
    set({ selected: selection.at(-1) ?? null, selection, drawingPath: null, navTool: null });
    return;
  }
  set({ selected, selection: ids, drawingPath: null, navTool: null });
}

/** bundles the selection into a new group; returns its id */
export function groupSelection(): string | null {
  if (state.selection.length < 2) return null;
  const id = `group_${randomHex(6)}`;
  const chosen = new Set(state.selection);
  edit((p) => {
    const groups = p.groups ?? [];
    return {
      ...p,
      groups: [...groups, { id, name: `Group ${groups.length + 1}` }],
      items: p.items.map((i) => (chosen.has(i.id) ? { ...i, group: id } : i)),
    };
  });
  return id;
}

/** dissolves a group: its members stay where they are, each on its own again */
export function ungroup(group: string) {
  edit((p) => ({
    ...p,
    groups: (p.groups ?? []).filter((g) => g.id !== group),
    items: p.items.map((i) => (i.group === group ? { ...i, group: undefined } : i)),
  }));
}

export function renameGroup(group: string, name: string) {
  edit(
    (p) => ({ ...p, groups: (p.groups ?? []).map((g) => (g.id === group ? { ...g, name } : g)) }),
    `group-${group}`,
  );
}

/** several items changed as one undo step (a group dragged together) */
export function updateItems(change: (item: Item) => Item | null) {
  edit((p) => ({ ...p, items: p.items.map((i) => change(i) ?? i) }));
}

export function removeSelection() {
  const gone = new Set(state.selection);
  edit((p) => ({ ...p, items: p.items.filter((i) => !gone.has(i.id)) }));
  set({ selected: null, drawingPath: null });
}
export const setNavTool = (navTool: EditorState["navTool"], labelTags: string[] = []) =>
  set({
    navTool,
    labelTags,
    labelTarget: null,
    drawingPath: null,
    selected: navTool ? null : state.selected,
  });
export const setGizmo = (gizmo: Gizmo) => set({ gizmo });
export const setMode = (mode: Mode) => set({ mode, drawingPath: null });
export const setSnap = (snap: boolean) => set({ snap });
export const setShowCollision = (showCollision: boolean) => set({ showCollision });
export const setFancy = (change: Partial<Fancy>) => {
  const fancy = { ...state.fancy, ...change, chosen: true };
  try {
    localStorage.setItem(FANCY_KEY, JSON.stringify(fancy));
  } catch {
    // private window: this session only
  }
  set({ fancy });
};

/** whether a fancy feature is drawn: the switch on, and that feature on */
export const fancyOn = (f: Fancy, feature: Exclude<keyof Fancy, "on" | "chosen">) =>
  f.on && f[feature];

/** a software (CPU) WebGL renderer turns fancy rendering off by default (the viewer's first frame calls this) */
export function noticeRenderer(name: string) {
  if (state.fancy.chosen) return;
  if (/swiftshader|llvmpipe|softpipe|software|basic render|mesa offscreen|lavapipe/i.test(name)) {
    set({ fancy: { ...state.fancy, on: false } });
  }
}
export const setPreviewMotion = (previewMotion: boolean) => set({ previewMotion });
export const setDrawingPath = (drawingPath: string | null) => set({ drawingPath, navTool: null });

export function selectedItem(): Item | null {
  return state.project.items.find((i) => i.id === state.selected) ?? null;
}

export function addItem(item: Item) {
  edit((p) => ({ ...p, items: [...p.items, ...withKeys([item], p.items)] }));
  set({ selected: item.id });
}

export function addItems(items: Item[]) {
  edit((p) => ({ ...p, items: [...p.items, ...withKeys(items, p.items)] }));
  set({ selected: null });
}

/** rename an item's readable id; refuses one another item already has. Returns the error, if any. */
export function renameKey(id: string, wanted: string): string | null {
  const key = slug(wanted);
  if (state.project.items.some((i) => i.id !== id && i.key === key)) return `${key} is taken`;
  updateItem(id, (item) => ({ ...item, key }));
  return null;
}

export function updateItem(id: string, change: (item: Item) => Item, coalesce?: string) {
  edit((p) => ({ ...p, items: p.items.map((i) => (i.id === id ? change(i) : i)) }), coalesce);
}

export function removeItem(id: string) {
  edit((p) => ({ ...p, items: p.items.filter((i) => i.id !== id) }));
  if (state.selected === id) set({ selected: null, drawingPath: null });
}

export function duplicateItem(id: string) {
  const item = state.project.items.find((i) => i.id === id);
  if (!item) return;
  const copy = structuredClone(item);
  copy.id = newId();
  copy.name = `${item.name} copy`;
  delete copy.key;
  copy.position = [item.position[0] + 0.5, item.position[1] + 0.5, item.position[2]] as Vec3;
  addItem(copy);
}

export function setMover(id: string, mover: MoverPath | undefined) {
  updateItem(id, (item) => ({ ...item, mover }));
}

// ── floors ──

export function setActiveFloor(floor: string) {
  edit((p) => ({ ...p, activeFloor: floor }), "active-floor");
  const item = selectedItem();
  if (item && item.floor !== floor) set({ selected: null });
}

/**
 * A new floor 3 m over the top one, with a slab to stand on (without one, what's added to it floats in the air): over
 * the top floor's items and a meter around them, or 8 m square around `around` when that floor is empty.
 */
export function addFloor(around: Vec3 = [0, 0, 0]) {
  edit((p) => {
    const topFloor = p.floors.reduce((a, b) => (b.elevation > a.elevation ? b : a));
    const id = `floor_${randomHex(6)}`;
    const below = p.items.filter((i) =>
      i.floor === topFloor.id && !["light", "hill", "image"].includes(i.kind)
    );
    let [x0, y0, x1, y1] = [around[0] - 4, around[1] - 4, around[0] + 4, around[1] + 4];
    if (below.length) {
      [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const item of below) {
        const half = item.kind === "room"
          ? Math.max(item.params.width, item.params.depth) / 2
          : 0.5;
        x0 = Math.min(x0, item.position[0] - half - 1);
        y0 = Math.min(y0, item.position[1] - half - 1);
        x1 = Math.max(x1, item.position[0] + half + 1);
        y1 = Math.max(y1, item.position[1] + half + 1);
      }
    }
    const round = (v: number) => Math.round(v * 10) / 10;
    const floor: Floor = {
      id,
      name: `Floor ${p.floors.length + 1}`,
      elevation: topFloor.elevation + 3,
      slab: {
        thickness: 0.2,
        sizeX: round(Math.max(6, x1 - x0)),
        sizeY: round(Math.max(6, y1 - y0)),
        center: [round((x0 + x1) / 2), round((y0 + y1) / 2)],
      },
    };
    return { ...p, floors: [...p.floors, floor], activeFloor: id };
  });
  // what was selected is on another floor now
  set({ selected: null });
}

export function removeFloor(id: string) {
  edit((p) => {
    if (p.floors.length <= 1) return p;
    const floors = p.floors.filter((f) => f.id !== id);
    return {
      ...p,
      floors,
      items: p.items.filter((i) => i.floor !== id),
      spawns: p.spawns.filter((s) => s.floor !== id),
      activeFloor: p.activeFloor === id ? floors[0].id : p.activeFloor,
    };
  });
}

export function updateFloor(id: string, change: Partial<Floor>) {
  edit(
    (p) => ({ ...p, floors: p.floors.map((f) => (f.id === id ? { ...f, ...change } : f)) }),
    `floor-${id}`,
  );
}

export function renameProject(name: string) {
  edit((p) => ({ ...p, name }), "name");
}

// ── labels (annotations) ──

/** the path or area further clicks extend */
export const setLabelTarget = (id: string | null) => set({ labelTarget: id });

export function selectLabel(id: string | null) {
  set({ selectedLabel: id });
}

export function updateLabel(id: string, change: (a: Annotation) => Annotation, coalesce?: string) {
  edit((p) => ({
    ...p,
    annotations: (p.annotations ?? []).map((a) => (a.id === id ? change(a) : a)),
  }), coalesce);
}

export function removeLabel(id: string) {
  edit((p) => ({ ...p, annotations: (p.annotations ?? []).filter((a) => a.id !== id) }));
  if (state.selectedLabel === id) set({ selectedLabel: null });
  if (state.labelTarget === id) set({ labelTarget: null });
}

/** a click on the floor while a label tool is on: a new point, or the next corner of the path or area being drawn */
export function addLabelPoint(point: Vec3) {
  const tool = state.navTool;
  if (tool !== "point" && tool !== "path" && tool !== "area") return;
  const floor = state.project.activeFloor;
  const tags = state.labelTags;
  const existing = state.project.annotations ?? [];
  const extending = existing.find((a) => a.id === state.labelTarget);
  if (extending && tool !== "point") {
    updateLabel(extending.id, (a) => ({ ...a, points: [...(a.points ?? []), point] }));
    return;
  }
  const goal = tags.includes(NAV_GOAL);
  const same = existing.filter((a) => a.kind === tool && (goal ? a.tags.includes(NAV_GOAL) : true));
  const name = goal
    ? "Goal"
    : tags.includes(NAV_MAPPING)
    ? "Mapping walk"
    : { point: "Point", path: "Path", area: "Area" }[tool];
  const label: Annotation = {
    id: randomHex(8),
    kind: tool,
    label: `${name} ${same.length + 1}`,
    tags,
    floor,
    ...(tool === "point" ? { position: point, yaw: 0 } : { points: [point] }),
    ...(tool === "area" ? { height: 2 } : {}),
    ...(goal ? { props: { tolerance: 0.5, timeout: 120, order: same.length } } : {}),
    ...(tags.includes(NAV_MAPPING)
      ? {
        props: {
          start_spawn: (state.project.spawns[0]?.name ?? "default").toLowerCase().replace(
            /[^a-z0-9]+/g,
            "_",
          ),
        },
      }
      : {}),
  };
  edit((p) => ({ ...p, annotations: [...(p.annotations ?? []), label] }));
  set({ selectedLabel: label.id, labelTarget: tool === "point" ? null : label.id });
}

/** remembers a camera view; its key comes from the name (unique among the world's views); returns the key */
export function saveView(camera: Omit<CameraView, "key" | "name">, name?: string): string {
  const views = state.project.views ?? [];
  let n = views.length + 1;
  while (views.some((v) => v.name === `View ${n}`)) n++;
  const [added] = withViewKeys([...views, { key: "", name: name ?? `View ${n}`, ...camera }]).slice(
    -1,
  );
  edit((p) => ({ ...p, views: [...(p.views ?? []), added] }));
  return added.key;
}

/** renames a view and re-derives its key from the new name, unless that key is taken */
export function renameView(key: string, name: string): string | null {
  const wanted = slug(name).replace(/^item_/, "view_");
  const views = state.project.views ?? [];
  if (views.some((v) => v.key !== key && v.key === wanted)) return `${wanted} is taken`;
  edit((p) => ({
    ...p,
    views: (p.views ?? []).map((v) => (v.key === key ? { ...v, name, key: wanted } : v)),
  }), `view-name-${key}`);
  return null;
}

/** points a view at where the camera is now */
export function updateView(key: string, camera: Omit<CameraView, "key" | "name">) {
  edit((p) => ({
    ...p,
    views: (p.views ?? []).map((v) => (v.key === key ? { ...v, ...camera } : v)),
  }));
}

export function removeView(key: string) {
  edit((p) => ({ ...p, views: (p.views ?? []).filter((v) => v.key !== key) }));
}

// ── a right-click menu on an item ──

export interface ContextMenuState {
  x: number;
  y: number;
  itemId: string;
}
let menu: ContextMenuState | null = null;
const menuListeners = new Set<() => void>();
export const openMenu = (next: ContextMenuState | null) => {
  menu = next;
  menuListeners.forEach((l) => l());
};
export const useMenu = () =>
  useSyncExternalStore((l) => {
    menuListeners.add(l);
    return () => menuListeners.delete(l);
  }, () => menu);

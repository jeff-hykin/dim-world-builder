// The 3D view: the world (as the exporter will write it), the transform gizmo, mover paths, and in viewer mode the
// live robot and movers from a running blueprint.

import { useCallback, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  PointCloud,
  Scene3D,
  SceneControls,
  TfFeed,
  useLayer,
  useTf,
  useViewer,
} from "../three_view.ts";
import { useSubscription } from "../ui.ts";
import { buildWorld, type World } from "../world/geometry.ts";
import { moverPose } from "../world/movers.ts";
import { NAV_GOAL } from "../world/annotations.ts";
import type { Item, MeshAsset, Project, Quat, Vec3 } from "../world/types.ts";
import {
  bodyObject,
  disposeObject,
  fancyLook,
  floorLevels,
  ghost,
  livelyMaterials,
  slabAO,
} from "./three_world.ts";
import { bakeFloorAO, clearFloorAO, type FloorAO, floorAO } from "./floor_ao.ts";
import { fadeGrid, gridFocus, SKY, skyDome, SUN_DIRECTION, windTime } from "./nature.ts";
import {
  addItem,
  addLabelPoint,
  edit,
  fancyOn,
  getState,
  noticeRenderer,
  openMenu,
  select,
  setDrawingPath,
  setNavTool,
  updateItem,
  updateItems,
  useEditor,
} from "./store.ts";
import { makeItem } from "../world/defaults.ts";

/** keep the tag tool on after a placement (one tag per click) */
const setNavToolTag = () => setNavTool("tag");
import { themeColor } from "./theme_color.ts";
import { cameraListeners, view } from "./palette.ts";

const SNAP = { translate: 0.1, rotate: Math.PI / 12, scale: 0.05 };

export function Viewport({ assets }: { assets: Record<string, MeshAsset> }) {
  const mode = useEditor((s) => s.mode);
  return (
    <Scene3D
      fixedFrame="world"
      style={{ position: "absolute", inset: 0 }}
      cameraPosition={[-9, -12, 10]}
      cameraTarget={[2, 0, 0]}
      gridSize={120}
      grid={mode !== "view"}
      viewCube="top-right"
      onViewer={(viewer) => {
        const track = () => {
          const t = viewer.controls.target;
          view.center = [t.x, t.y, 0];
          cameraListeners.forEach((listener) => listener());
        };
        viewer.controls.addEventListener("change", track);
        track();
        // a plan editor's mouse: drag pans along the floor, Shift-drag (OrbitControls' modifier) or right-drag
        // orbits, the wheel zooms
        const controls = viewer.controls as unknown as {
          mouseButtons: Record<string, number>;
          touches: Record<string, number>;
          screenSpacePanning: boolean;
        };
        controls.mouseButtons = {
          LEFT: THREE.MOUSE.PAN,
          MIDDLE: THREE.MOUSE.DOLLY,
          RIGHT: THREE.MOUSE.ROTATE,
        };
        // touch, the same way: one finger pans, two pinch to zoom and twist/drag to orbit
        controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
        controls.screenSpacePanning = false;
        exposeForAutomation(viewer);
        // a resize (dragging a side panel's edge) clears the canvas and the view only redraws next frame: draw now,
        // before the page paints, so it doesn't flash (this observer runs after the viewer's own, which resized it)
        const host = viewer.canvas.parentElement;
        if (host) {
          const redraw = new ResizeObserver(() => {
            if (!viewer.canvas.isConnected) return redraw.disconnect();
            viewer.renderer?.render(viewer.scene, viewer.camera);
            viewer.requestRender();
          });
          redraw.observe(host);
        }
      }}
    >
      <Lighting />
      <WorldLayer assets={assets} />
      {mode === "edit" && <Gizmo />}
      {mode === "edit" && <MoverPaths />}
      {mode === "edit" && <FloorMarkers />}
      <NavOverlay />
      {mode === "view" && <LiveRobot />}
      <SceneControls />
    </Scene3D>
  );
}

/** an item's drawn object, by its id or readable key */
function drawnItem(idOrKey: string): THREE.Object3D | undefined {
  const item = getState().project.items.find((i) => i.id === idOrKey || i.key === idOrKey);
  return item && view.worldRoot?.children.find((o) => o.userData.itemId === item.id);
}

/**
 * `window.dimWorldBuilder`: where things are on screen, for scripted demos and UI tests (page coordinates), and a way
 * to aim the camera. Read-only for the project: edits still go through the UI.
 */
function exposeForAutomation(viewer: {
  camera: THREE.PerspectiveCamera;
  controls: { target: THREE.Vector3; update(): void };
  renderer: THREE.WebGLRenderer | null;
  canvas: HTMLCanvasElement;
  scene: THREE.Scene;
  requestRender(): void;
}) {
  const toScreen = (point: THREE.Vector3): [number, number] => {
    const rect = viewer.canvas.getBoundingClientRect();
    viewer.camera.updateMatrixWorld();
    const ndc = point.clone().project(viewer.camera);
    return [rect.left + ((ndc.x + 1) / 2) * rect.width, rect.top + ((1 - ndc.y) / 2) * rect.height];
  };
  const round = (v: THREE.Vector3) => v.toArray().map((x) => Math.round(x * 1000) / 1000) as Vec3;
  view.camera = {
    get: () => ({
      eye: round(viewer.camera.position),
      target: round(viewer.controls.target),
      fov: Math.round(viewer.camera.fov * 10) / 10,
    }),
    goTo: (eye, target, fov) =>
      glideTo(viewer, new THREE.Vector3(...eye), new THREE.Vector3(...target), fov),
    frame(idOrKey) {
      const object = drawnItem(idOrKey);
      if (!object) return false;
      const bounds = new THREE.Box3().setFromObject(object);
      glide(
        viewer as unknown as Parameters<typeof glide>[0],
        bounds.getCenter(new THREE.Vector3()),
        Math.max(2.5, bounds.getSize(new THREE.Vector3()).length() * 1.6),
      );
      return true;
    },
    blink(idsOrKeys, seconds) {
      // each item's object is found again every tick: the world layer rebuilds them on every edit
      const ids = idsOrKeys.map((ref) =>
        getState().project.items.find((i) => i.id === ref || i.key === ref)?.id
      ).filter((id): id is string => Boolean(id));
      const objects = () =>
        view.worldRoot?.children.filter((o) => ids.includes(o.userData.itemId as string)) ?? [];
      const started = performance.now();
      const tick = () => {
        const on = performance.now() - started >= seconds * 1000;
        const shown = on || Math.floor((performance.now() - started) / 250) % 2 === 0;
        for (const object of objects()) object.visible = shown;
        viewer.requestRender();
        if (!on) setTimeout(tick, 125);
      };
      tick();
    },
  };
  Object.assign(globalThis, {
    dimWorldBuilder: {
      /** where the camera is and looks */
      view: () => view.camera?.get(),
      /** mean milliseconds to draw one frame of the current view (GPU included), for checking a look's cost */
      frameMs(frames = 30): number {
        const renderer = viewer.renderer;
        if (!renderer) return NaN; // no WebGL: nothing draws
        const gl = renderer.getContext();
        renderer.render(viewer.scene, viewer.camera);
        gl.finish();
        const start = performance.now();
        for (let i = 0; i < frames; i++) renderer.render(viewer.scene, viewer.camera);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
        return (performance.now() - start) / frames;
      },
      /** an item's origin (its base) on screen */
      itemOnScreen(id: string): [number, number] | null {
        const object = view.worldRoot?.children.find((o) => o.userData.itemId === id);
        return object ? toScreen(object.getWorldPosition(new THREE.Vector3())) : null;
      },
      worldToScreen: (x: number, y: number, z: number) => toScreen(new THREE.Vector3(x, y, z)),
      /**
       * A point on the gizmo of the selected item, in the gizmo's own units (its arrows/rings reach 0.5), e.g.
       * [0.3, 0, 0] on the X arrow, [0.15, 0.15, 0] on the XY plane handle, [0.35, 0.35, 0] on the Z ring.
       * Uses TransformControls' own on-screen sizing: distance * min(1.9 tan(fov/2), 7) / 4.
       */
      gizmoOnScreen(id: string, local: [number, number, number]): [number, number] | null {
        const object = view.worldRoot?.children.find((o) => o.userData.itemId === id);
        if (!object) return null;
        viewer.camera.updateMatrixWorld();
        const origin = object.getWorldPosition(new THREE.Vector3());
        const factor = origin.distanceTo(viewer.camera.position) *
          Math.min(1.9 * Math.tan((Math.PI * viewer.camera.fov) / 360) / viewer.camera.zoom, 7) / 4;
        const offset = new THREE.Vector3(...local).applyQuaternion(
          object.getWorldQuaternion(new THREE.Quaternion()),
        )
          .multiplyScalar(factor);
        return toScreen(origin.add(offset));
      },
      /** glide to an item by its readable id, as a double-click on it does */
      focus(key: string) {
        const item = getState().project.items.find((i) => i.key === key);
        const object = item && view.worldRoot?.children.find((o) => o.userData.itemId === item.id);
        if (!object) return false;
        const bounds = new THREE.Box3().setFromObject(object);
        glide(
          viewer as unknown as Parameters<typeof glide>[0],
          bounds.getCenter(new THREE.Vector3()),
          Math.max(2.5, bounds.getSize(new THREE.Vector3()).length() * 1.6),
        );
        return true;
      },
      /** glide to a remembered view by its key, as clicking it in Views does */
      goToView(key: string) {
        const saved = getState().project.views?.find((v) => v.key === key);
        if (!saved) return false;
        view.camera?.goTo(saved.eye, saved.target, saved.fov);
        return true;
      },
      lookAt(target: [number, number, number], from: [number, number, number]) {
        const place = () => {
          viewer.camera.position.set(...from);
          viewer.controls.target.set(...target);
          viewer.controls.update();
          viewer.requestRender();
        };
        // again after the scene's own camera easing settles
        place();
        setTimeout(place, 400);
      },
      state: () => getState(),
    },
  });
}

/** the GPU behind a renderer, e.g. "ANGLE (Apple, Apple M2, ...)" or "llvmpipe (LLVM 20)" */
function rendererName(renderer: THREE.WebGLRenderer): string {
  const gl = renderer.getContext();
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "");
}

/** sun + sky light with soft shadows, so the world reads as solid shapes, not flat colors */
function Lighting() {
  const mode = useEditor((s) => s.mode);
  const softShadows = useEditor((s) => fancyOn(s.fancy, "shadows"));
  const skyOn = useEditor((s) => fancyOn(s.fancy, "sky"));
  useLayer(({ viewer }) => {
    const renderer = viewer.renderer;
    if (!renderer) return null; // no WebGL: nothing draws, so no look to set up
    noticeRenderer(rendererName(renderer));
    const root = new THREE.Group();
    renderer.shadowMap.enabled = true;
    // variance shadow maps blur the map itself (a smooth, wide penumbra: a hazy, diffuse sun); PCF's 17 taps band when
    // spread that wide, and PCFSoft ignores the radius
    renderer.shadowMap.type = softShadows ? THREE.VSMShadowMap : THREE.PCFShadowMap;
    // Neutral keeps greens green (ACES pulls foliage toward gray-olive)
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    // the world's look, not the page's skin: a sky, its light on everything, a warm sun, haze toward the horizon
    const sky = skyDome();
    const scene = viewer.scene;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const skyScene = new THREE.Scene();
    skyScene.add(skyDome());
    const environment = pmrem.fromScene(skyScene, 0.04).texture;
    const before = {
      environment: scene.environment,
      environmentIntensity: scene.environmentIntensity,
      fog: scene.fog,
    };
    // without the sky: no dome, no image-based light, no haze (the hemisphere fill and sun still light the world)
    scene.environment = skyOn ? environment : null;
    scene.environmentIntensity = 0.7;
    scene.fog = skyOn
      ? new THREE.Fog(SKY.horizon.clone(), mode === "view" ? 45 : 70, mode === "view" ? 220 : 320)
      : null;
    sky.visible = skyOn;
    // fill: blue from above, a green-brown bounce from the ground
    const fill = new THREE.HemisphereLight(
      new THREE.Color(0.62, 0.75, 0.95),
      new THREE.Color(0.42, 0.4, 0.3),
      0.8,
    );
    fill.up.set(0, 0, 1);
    fill.position.set(0, 0, 50);
    // a diffuse sun: less direct light, more sky fill, soft-edged shadows that still read on a light floor
    const sun = new THREE.DirectionalLight(SKY.sun.clone(), 2.0);
    sun.position.copy(SUN_DIRECTION).multiplyScalar(60);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    const extent = 40;
    Object.assign(sun.shadow.camera, {
      left: -extent,
      right: extent,
      top: extent,
      bottom: -extent,
      far: 160,
    });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = softShadows ? 12 : 1;
    sun.shadow.blurSamples = 16;
    // editing: only shadows over the grid; viewing: a concrete ground with a soft checker, like the simulation's
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(800, 800),
      mode === "view"
        ? new THREE.MeshStandardMaterial({ map: checker(), roughness: 0.95 })
        : new THREE.ShadowMaterial({ opacity: 0.25 }),
    );
    ground.receiveShadow = true;
    ground.position.z = -0.001;
    // the world's own floor at z = 0 is 1 mm above it, too close for the depth buffer from a distance: push the
    // ground back in depth so a floor always wins (else the shadow catcher's shadows stripe through it)
    Object.assign(ground.material, {
      polygonOffset: true,
      polygonOffsetFactor: 4,
      polygonOffsetUnits: 4,
    });
    ground.userData.ground = true;
    root.add(sky, fill, sun, sun.target, ground);
    // the sky stays centered on the camera
    const off = viewer.onFrame(({ camera }: { camera: THREE.Camera }) => {
      sky.position.copy(camera.position);
      // the grid reaches a little past what the camera orbits, never far out where it can only alias
      gridFocus.value = Math.min(
        40,
        Math.max(8, camera.position.distanceTo(viewer.controls.target)),
      );
      // the viewer remakes its grid on a theme change: fade each new one
      for (const child of scene.children) {
        if ((child as THREE.GridHelper).isLineSegments && child.type === "GridHelper") {
          fadeGrid(child);
          // the grid lies on the floor being edited, so that floor is plain to see
          const { floors, activeFloor } = getState().project;
          child.position.z = (floors.find((f) => f.id === activeFloor)?.elevation ?? 0) + 0.002;
        }
      }
    });
    return {
      root,
      dispose: () => {
        off?.();
        scene.environment = before.environment;
        scene.environmentIntensity = before.environmentIntensity;
        scene.fog = before.fog;
        environment.dispose();
        pmrem.dispose();
        disposeObject(skyScene);
        disposeObject(root);
      },
    };
  }, [mode, softShadows, skyOn]);
  return null;
}

/** a 1 m checker for the viewer's ground, drawn once (two grays of the world's concrete) */
function checker(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const tone = (v: number) => new THREE.Color(v, v * 1.02, v * 1.05).getStyle();
  ctx.fillStyle = tone(0.36);
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = tone(0.335);
  ctx.fillRect(0, 0, 32, 32);
  ctx.fillRect(32, 32, 32, 32);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(200, 200);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter; // far away it blends to one gray instead of shimmering
  texture.anisotropy = 16;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** whether any grass is in the world (it animates, so the view keeps drawing) */
function hasGrass(root: THREE.Object3D): boolean {
  let found = false;
  root.traverse((object) => {
    if (object.userData.grass) found = true;
  });
  return found;
}

interface WorldLayerState {
  root: THREE.Group;
  objects: Map<string, THREE.Group>;
  /** grass is drawn: the wind animates it */
  grass: boolean;
}

/** every item as three.js objects, rebuilt when the project changes; ghosts the floors not being edited */
function WorldLayer({ assets }: { assets: Record<string, MeshAsset> }) {
  const project = useEditor((s) => s.project);
  const showCollision = useEditor((s) => s.showCollision);
  const grass = useEditor((s) => fancyOn(s.fancy, "grass"));
  const occlusion = useEditor((s) => fancyOn(s.fancy, "occlusion"));
  const detail = useEditor((s) => fancyOn(s.fancy, "detail"));
  const mode = useEditor((s) => s.mode);
  const world = useMemo(() => buildWorld(project, assets), [project, assets]);
  const worldRef = useRef<World>(world);
  // stable, so the picker's pointer listeners aren't re-added (and a click's pointerdown forgotten) on every render
  const pickable = useCallback(
    () => (layer.current as unknown as { state: WorldLayerState } | null)?.state.objects,
    [],
  );
  const framed = useRef(-1);
  const aoTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const aoByFloor = useRef(new Map<string, FloorAO>());
  const opened = useEditor((s) => s.opened);
  worldRef.current = world;
  const tf = useTf();
  const layer = useLayer(({ viewer }) => {
    let motionStart = performance.now() / 1000;
    let motionShown = false;
    const root = new THREE.Group();
    root.name = "world";
    view.worldRoot = root;
    const state: WorldLayerState = { root, objects: new Map(), grass: false };
    return {
      root,
      state,
      viewer,
      update: () => {
        // grass sways: advance the wind and keep drawing while any is on screen
        if (state.grass) {
          windTime.value = performance.now() / 1000;
          viewer.requestRender();
        }
        // edit mode with "Play motion": movers ride their paths as the simulation will move them
        const editing = getState().mode !== "view";
        if (editing && getState().previewMotion) {
          const time = performance.now() / 1000 - motionStart;
          for (const mover of worldRef.current.movers) {
            const body = worldRef.current.bodies.find((b) => b.name === mover.body);
            const object = body && state.objects.get(body.itemId);
            const pose = object && moverPose(mover, time);
            if (!object || !pose) continue;
            object.position.set(...pose.position);
            if (pose.quat) object.quaternion.set(...pose.quat);
          }
          motionShown = true;
          viewer.requestRender();
          return;
        }
        if (motionShown) {
          // back to where they were authored
          motionShown = false;
          motionStart = performance.now() / 1000;
          for (const body of worldRef.current.bodies) {
            const object = body.mocap && state.objects.get(body.itemId);
            if (!object) continue;
            object.position.set(...body.pos);
            object.quaternion.set(...body.quat);
          }
          viewer.requestRender();
        }
        // viewer mode: movers ride their live TF (world -> <body>) from the running simulation
        if (editing || !tf) return;
        for (const body of worldRef.current.bodies) {
          if (!body.mocap) continue;
          const object = state.objects.get(body.itemId);
          const pose = tf.lookup(body.name, "world");
          if (object && pose) {
            pose.decompose(object.position, object.quaternion, new THREE.Vector3());
          }
        }
      },
      dispose: () => disposeObject(root),
    };
  }, [tf]);
  useEffect(() => {
    const live = layer.current as unknown as
      | {
        state: WorldLayerState;
        viewer: {
          requestRender(): void;
          renderer: THREE.WebGLRenderer | null;
          camera: THREE.PerspectiveCamera;
          controls: { target: THREE.Vector3; update(): void };
        };
      }
      | null;
    if (!live) return;
    const { root, objects } = live.state;
    for (const object of objects.values()) {
      root.remove(object);
      disposeObject(object);
    }
    objects.clear();
    const levels = project.floors.map((f) => f.elevation).slice(0, 4);
    floorLevels.value.set(
      ...([...levels, 1e6, 1e6, 1e6, 1e6].slice(0, 4) as [number, number, number, number]),
    );
    if (fancyLook.detail !== detail) {
      fancyLook.detail = detail;
      // the shared library materials recompile with or without their surface shaders
      for (const material of livelyMaterials()) material.needsUpdate = true;
    }
    const style = { collisionColor: themeColor("var(--danger)"), showCollision, grass };
    for (const body of world.bodies) {
      const object = bodyObject(body, assets, style, () => {
        live.viewer.requestRender();
        bake();
      });
      const editable = mode === "view" || body.floor === project.activeFloor;
      // floors above the one being edited are see-through, so it can be seen; it and those below draw solid (only
      // its own items can be picked)
      const level = (floor: string) => project.floors.find((f) => f.id === floor)?.elevation ?? 0;
      ghost(object, mode !== "view" && level(body.floor) > level(project.activeFloor));
      // the floor slab is ground, not an item to pick
      object.userData.pickable = editable && mode === "edit" && body.kind !== "slab";
      objects.set(body.itemId, object);
      root.add(object);
    }
    live.state.grass = hasGrass(root);
    // what a new object lands on: the highest surface of the active floor under (x, y), below head height (so not
    // a room's ceiling); the floor itself when nothing is there
    view.surfaceAt = (x, y, exclude) => {
      const floor = project.floors.find((f) => f.id === project.activeFloor);
      const base = floor?.elevation ?? 0;
      root.updateMatrixWorld();
      const own = [...objects.values()].filter((o) =>
        o.userData.floor === project.activeFloor && o.userData.itemId !== exclude
      );
      const down = new THREE.Raycaster(
        new THREE.Vector3(x, y, base + 1.9),
        new THREE.Vector3(0, 0, -1),
        0,
        2.4,
      );
      // solid surfaces only: not grass blades, nor the see-through handles and collision wireframes
      const solid = (o: THREE.Object3D) =>
        o.visible && !(o as THREE.InstancedMesh).isInstancedMesh &&
        !((o as THREE.Mesh).material instanceof THREE.MeshBasicMaterial);
      const hit = down.intersectObjects(own, true).find((h) => solid(h.object));
      return hit ? Math.max(0, Math.round((hit.point.z - base) * 100) / 100) : 0;
    };
    // each floor's slab reads one shared occlusion map (before its shader compiles), which the bake below fills
    for (const floor of project.floors) {
      const slab = objects.get(`slab:${floor.id}`);
      if (!slab) continue;
      const shared = aoByFloor.current.get(floor.id) ?? floorAO();
      aoByFloor.current.set(floor.id, shared);
      slab.traverse((child) => {
        const m = (child as THREE.Mesh).material as THREE.Material | undefined;
        if (m && slabAO.has(m)) slabAO.set(m, shared);
      });
    }
    // the floors' sky occlusion, re-baked shortly after the world (or a late-loading model) changes
    const bake = () => {
      clearTimeout(aoTimer.current);
      aoTimer.current = setTimeout(() => {
        const start = performance.now();
        for (const floor of project.floors) {
          const slab = objects.get(`slab:${floor.id}`);
          if (!slab || !floor.slab || !aoByFloor.current.has(floor.id)) continue;
          const shared = aoByFloor.current.get(floor.id)!;
          // occlusion off: nothing to bake (and nothing to hide, which would stay hidden)
          if (!occlusion || !live.viewer.renderer) {
            clearFloorAO(shared);
            continue;
          }
          // only what stands on this floor and stays put
          const shown = new Map<THREE.Object3D, boolean>();
          for (const body of world.bodies) {
            const object = objects.get(body.itemId);
            if (!object) continue;
            shown.set(object, object.visible);
            object.visible = body.floor === floor.id && !body.mocap &&
              !["slab", "hill", "hole", "light", "image"].includes(body.kind);
          }
          bakeFloorAO(live.viewer.renderer, root, floor.elevation, {
            x0: floor.slab.center[0] - floor.slab.sizeX / 2,
            y0: floor.slab.center[1] - floor.slab.sizeY / 2,
            sizeX: floor.slab.sizeX,
            sizeY: floor.slab.sizeY,
          }, shared);
          for (const [object, visible] of shown) object.visible = visible;
        }
        // for automation: how long the bake took, and the maps (to check them)
        Object.assign(globalThis, {
          dimWorldBuilderAO: { ms: performance.now() - start, floors: aoByFloor.current },
        });
        live.viewer.requestRender();
      }, 250);
    };
    // a different world was opened: frame all of it (once; an empty world is never framed later)
    const justOpened = framed.current !== opened;
    framed.current = opened;
    const framedBodies = world.bodies.filter((b) => b.kind !== "slab");
    if (justOpened && framedBodies.length) {
      // the items, not the (huge) floor slabs
      const bounds = new THREE.Box3();
      for (const b of framedBodies) {
        const object = objects.get(b.itemId);
        if (object) bounds.expandByObject(object);
      }
      const center = bounds.getCenter(new THREE.Vector3());
      const size = Math.max(4, bounds.getSize(new THREE.Vector3()).length());
      const frame = () => {
        live.viewer.controls.target.set(center.x, center.y, 0);
        live.viewer.camera.position.set(center.x - size * 0.45, center.y - size * 0.6, size * 0.55);
        live.viewer.controls.update();
        live.viewer.requestRender();
      };
      // after the scene's own first camera placement
      frame();
      setTimeout(frame, 400);
    }
    bake();
    live.viewer.requestRender();
  }, [world, assets, showCollision, grass, occlusion, detail, mode, project.activeFloor, layer]);
  // switching floors (or moving one) lifts the camera with it, so the floor being edited stays in view
  const elevation = project.floors.find((f) => f.id === project.activeFloor)?.elevation ?? 0;
  useEffect(() => {
    const live = layer.current as unknown as
      | {
        viewer: {
          camera: THREE.Camera;
          controls: { target: THREE.Vector3; update(): void };
          requestRender(): void;
        };
      }
      | null;
    if (!live) return;
    const { controls, camera } = live.viewer;
    const from = controls.target.z;
    if (Math.abs(elevation - from) < 1e-3) return;
    // eased over 0.4 s, target and camera together
    const started = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / 400);
      const z = from + (elevation - from) * (1 - (1 - t) ** 3);
      camera.position.z += z - controls.target.z;
      controls.target.z = z;
      controls.update();
      live.viewer.requestRender();
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [elevation, layer]);
  return <Picker objects={pickable} />;
}

/** a click (not a drag) selects the item under it, or adds a mover waypoint while drawing a path */
function Picker({ objects }: { objects: () => Map<string, THREE.Group> | undefined }) {
  const viewer = useViewer();
  useEffect(() => {
    if (!viewer) return;
    const canvas = viewer.canvas;
    let down: { x: number; y: number } | null = null;
    const raycaster = new THREE.Raycaster();
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
      // inside Desktop the page is an iframe: take the keyboard, so Esc, Delete and W/E/R reach it
      globalThis.focus();
    };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || e.button !== 0) return;
      down = null;
      if ((viewer as unknown as { gizmoDragging?: boolean }).gizmoDragging) return;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      viewer.scene.updateMatrixWorld();
      raycaster.setFromCamera(ndc, viewer.camera);
      const state = getState();
      if (state.navTool === "tag") {
        // stick a tag on whatever surface is under the click, facing out of it
        const surfaces = [...(objects()?.values() ?? [])].filter((o) => o.userData.pickable);
        const hit = raycaster.intersectObjects(surfaces, true).find((h) => h.face);
        if (hit?.face) {
          const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
            .normalize();
          if (normal.dot(raycaster.ray.direction) > 0) normal.negate();
          placeTag(hit.point.clone().addScaledVector(normal, 0.001), normal);
        }
        return;
      }
      if (state.navTool) {
        const floor = state.project.floors.find((f) => f.id === state.project.activeFloor);
        const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -(floor?.elevation ?? 0));
        const hit = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
        if (hit) addLabelPoint([Math.round(hit.x * 10) / 10, Math.round(hit.y * 10) / 10, 0]);
        return;
      }
      if (state.drawingPath) {
        const floor = state.project.floors.find((f) => f.id === state.project.activeFloor);
        const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -(floor?.elevation ?? 0));
        const hit = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
        if (hit) addWaypoint(state.drawingPath, [hit.x, hit.y, 0]);
        return;
      }
      const pickable = [...(objects()?.values() ?? [])].filter((o) => o.userData.pickable);
      const hit = raycaster.intersectObjects(pickable, true)[0];
      let node: THREE.Object3D | null = hit?.object ?? null;
      while (node && !node.userData.itemId) node = node.parent;
      // Shift adds to the selection (an empty click keeps it); Alt picks one member out of its group
      if (!node && e.shiftKey) return;
      select(node ? (node.userData.itemId as string) : null, { add: e.shiftKey, member: e.altKey });
    };
    const ndcOf = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
    };
    const itemUnder = (e: MouseEvent): { object: THREE.Object3D; point: THREE.Vector3 } | null => {
      // the view renders on demand: poses changed since its last frame aren't in the world matrices yet
      viewer.scene.updateMatrixWorld();
      raycaster.setFromCamera(ndcOf(e), viewer.camera);
      const pickable = [...(objects()?.values() ?? [])].filter((o) => o.userData.pickable);
      const hit = raycaster.intersectObjects(pickable, true)[0];
      let node: THREE.Object3D | null = hit?.object ?? null;
      while (node && !node.userData.itemId) node = node.parent;
      return node && hit ? { object: node, point: hit.point } : null;
    };
    // double-click: glide the camera to the item (framing it) or to the spot on the ground
    const onDouble = (e: MouseEvent) => {
      const under = itemUnder(e);
      let target: THREE.Vector3;
      let distance: number;
      if (under) {
        // its bounding sphere just fills the view (with a little room around it)
        const sphere = new THREE.Box3().setFromObject(under.object).getBoundingSphere(
          new THREE.Sphere(),
        );
        target = sphere.center;
        const halfFov = THREE.MathUtils.degToRad(viewer.camera.fov) / 2;
        distance = Math.max(1.2, (sphere.radius / Math.sin(halfFov)) * 1.2);
        select(under.object.userData.itemId as string);
      } else {
        raycaster.setFromCamera(ndcOf(e), viewer.camera);
        const { floors, activeFloor } = getState().project;
        const level = floors.find((f) => f.id === activeFloor)?.elevation ?? 0;
        const hit = raycaster.ray.intersectPlane(
          new THREE.Plane(new THREE.Vector3(0, 0, 1), -level),
          new THREE.Vector3(),
        );
        if (!hit) return;
        target = hit;
        distance = viewer.camera.position.distanceTo(viewer.controls.target) * 0.7;
      }
      glide(viewer, target, distance);
    };
    // right-click on an item: its menu (rename its id, focus, duplicate, remove)
    const onContext = (e: MouseEvent) => {
      const under = itemUnder(e);
      if (!under) return;
      e.preventDefault();
      const id = under.object.userData.itemId as string;
      // keep a multi-selection the click lands in, for Group
      if (!getState().selection.includes(id)) select(id);
      openMenu({ x: e.clientX, y: e.clientY, itemId: id });
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("dblclick", onDouble);
    canvas.addEventListener("contextmenu", onContext);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("dblclick", onDouble);
      canvas.removeEventListener("contextmenu", onContext);
    };
  }, [viewer, objects]);
  return null;
}

/** OrbitControls' leftover inertia (private fields), cleared so a placed camera doesn't drift on */
function clearDamping(controls: unknown) {
  const c = controls as {
    _sphericalDelta?: THREE.Spherical;
    _panOffset?: THREE.Vector3;
    _scale?: number;
  };
  c._sphericalDelta?.set(0, 0, 0);
  c._panOffset?.set(0, 0, 0);
  if (c._scale !== undefined) c._scale = 1;
}

/** ease the camera to look at `target` from `distance` away, keeping its viewing direction (about 0.7 s) */
function glide(
  viewer: {
    camera: THREE.PerspectiveCamera;
    controls: { target: THREE.Vector3; update(): void };
    requestRender(): void;
  },
  target: THREE.Vector3,
  distance: number,
) {
  const fromTarget = viewer.controls.target.clone();
  const fromPosition = viewer.camera.position.clone();
  const direction = fromPosition.clone().sub(fromTarget).normalize();
  const toPosition = target.clone().addScaledVector(direction, distance);
  const started = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - started) / 700);
    const ease = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    viewer.controls.target.lerpVectors(fromTarget, target, ease);
    viewer.camera.position.lerpVectors(fromPosition, toPosition, ease);
    // the double-click's own drag and zoom left inertia in OrbitControls: drop it, or the camera sails past
    clearDamping(viewer.controls);
    viewer.controls.update();
    viewer.requestRender();
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** ease the camera to an exact eye, target and field of view (about 0.9 s) */
function glideTo(
  viewer: {
    camera: THREE.PerspectiveCamera;
    controls: { target: THREE.Vector3; update(): void };
    requestRender(): void;
  },
  eye: THREE.Vector3,
  target: THREE.Vector3,
  fov = viewer.camera.fov,
) {
  const fromTarget = viewer.controls.target.clone();
  const fromPosition = viewer.camera.position.clone();
  const fromFov = viewer.camera.fov;
  const started = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - started) / 900);
    const ease = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    viewer.controls.target.lerpVectors(fromTarget, target, ease);
    viewer.camera.position.lerpVectors(fromPosition, eye, ease);
    viewer.camera.fov = fromFov + (fov - fromFov) * ease;
    viewer.camera.updateProjectionMatrix();
    clearDamping(viewer.controls);
    viewer.controls.update();
    viewer.requestRender();
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** a new AprilTag item at a world point, its front (+x) along the surface normal, its top up */
function placeTag(point: THREE.Vector3, normal: THREE.Vector3) {
  const state = getState();
  const floor = state.project.floors.find((f) => f.id === state.project.activeFloor);
  const yawAngle = Math.atan2(normal.y, normal.x);
  const pitch = -Math.asin(Math.max(-1, Math.min(1, normal.z)));
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, pitch, yawAngle, "ZYX"));
  const used = new Set(
    state.project.items.flatMap((i) => (i.kind === "apriltag" ? [i.params.id] : [])),
  );
  let id = 0;
  while (used.has(id)) id++;
  addItem(makeItem("apriltag", { family: "tag36h11", id, size: 0.1 }, {
    name: `Tag ${id}`,
    floor: state.project.activeFloor,
    position: [point.x, point.y, point.z - (floor?.elevation ?? 0)].map((v) =>
      Math.round(v * 1000) / 1000
    ) as Vec3,
    rotation: q.toArray() as Quat,
  }));
  setNavToolTag();
}

function addWaypoint(id: string, point: Vec3) {
  updateItem(id, (item) => {
    const mover = item.mover ??
      { waypoints: [], speed: 0.5, mode: "loop" as const, heading: "path" as const };
    const snapped = point.map((v) => Math.round(v * 10) / 10) as Vec3;
    return { ...item, mover: { ...mover, waypoints: [...mover.waypoints, snapped] } };
  });
}

/** the generators take a gizmo scale as new dimensions; primitives and meshes keep it as their scale */
function applyScale(item: Item, raw: Vec3): Item {
  // a wild drag can ask for any factor: keep each within 1/10..10x per drag
  const s = raw.map((v) => Math.min(10, Math.max(0.1, Math.abs(v)))) as Vec3;
  switch (item.kind) {
    case "room":
      return {
        ...item,
        params: {
          ...item.params,
          width: round(item.params.width * s[0]),
          depth: round(item.params.depth * s[1]),
          height: round(item.params.height * s[2]),
        },
      };
    case "stairs":
      return {
        ...item,
        params: {
          ...item.params,
          stepDepth: round(item.params.stepDepth * s[0], 0.01),
          width: round(item.params.width * s[1]),
          stepHeight: round(item.params.stepHeight * s[2], 0.01),
        },
      };
    case "hill":
      return {
        ...item,
        params: {
          ...item.params,
          sizeX: round(item.params.sizeX * s[0]),
          sizeY: round(item.params.sizeY * s[1]),
          amplitude: round(item.params.amplitude * s[2], 0.01),
        },
      };
    case "image":
      return {
        ...item,
        params: {
          ...item.params,
          width: round(item.params.width * s[1], 0.01),
          height: round(item.params.height * s[2], 0.01),
        },
      };
    default:
      return { ...item, scale: item.scale.map((v, i) => round(v * s[i], 0.01)) as Vec3 };
  }
}

const round = (v: number, step = 0.05) => Math.max(step, Math.round(v / step) * step);

/** translate / rotate / scale handles on the selected item; commits once per drag (one undo step) */
/** the selection outline: white lines on each selected mesh's creases and silhouette-making edges */
const OUTLINE = (() => {
  const material = new THREE.LineBasicMaterial({ color: 0xffffff, toneMapped: false });
  // nudged toward the camera, so lines on the surface win its depth test instead of flickering in and out
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      "#include <project_vertex>",
      "#include <project_vertex>\ngl_Position.z -= 0.0008 * gl_Position.w;",
    );
  };
  return material;
})();
const outlineEdges = new WeakMap<THREE.BufferGeometry, THREE.EdgesGeometry>();

/** an item with its pose taken from its drawn object (after a gizmo drag) */
function posedFrom(object: THREE.Object3D, item: Item): Item {
  const floor = getState().project.floors.find((f) => f.id === item.floor);
  const lift = floor?.elevation ?? 0;
  const scale: Vec3 = [object.scale.x, object.scale.y, object.scale.z];
  let next: Item = {
    ...item,
    // below the floor is allowed (a sunken pit, a basement step): no snapping back up
    position: [object.position.x, object.position.y, object.position.z - lift]
      .map((v) => Math.round(v * 1000) / 1000) as Vec3,
    rotation: object.quaternion.toArray() as Quat,
  };
  if (scale.some((v) => Math.abs(v - 1) > 1e-4)) next = applyScale(next, scale);
  return next;
}

// ── extend: a scale drag that moves only the grabbed side; the opposite face stays where it was ──

const AXES = { X: 0, Y: 1, Z: 2 } as const;
const UNIT = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

interface ExtendAxis {
  axis: 0 | 1 | 2;
  /** +1: the + side was grabbed (the - face is the anchor); -1 the reverse */
  side: 1 | -1;
  /** the anchor face's coordinate along the axis, in the object's own frame */
  anchor: number;
  /** the object's size along the axis when the drag started */
  size: number;
}
interface ExtendDrag {
  axes: ExtendAxis[];
  position: THREE.Vector3;
}

/** the meshes' bounds in `frame`'s own coordinates (what `frame` draws, or for the group pivot, its members) */
function localBounds(frame: THREE.Object3D, objects: THREE.Object3D[]): THREE.Box3 {
  frame.updateWorldMatrix(true, true);
  const toFrame = frame.matrixWorld.clone().invert();
  const box = new THREE.Box3();
  const part = new THREE.Box3();
  for (const object of objects) {
    object.updateWorldMatrix(true, true);
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible || mesh.userData.outline || !mesh.geometry) return;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      box.union(
        part.copy(mesh.geometry.boundingBox!).applyMatrix4(
          toFrame.clone().multiply(mesh.matrixWorld),
        ),
      );
    });
  }
  return box;
}

/** at a drag's start: the axes being extended, which side of each was grabbed, and where the anchor faces are */
function startExtend(
  controls: TransformControls,
  object: THREE.Object3D,
  contents: THREE.Object3D[],
): ExtendDrag | null {
  const letters = (controls.axis ?? "").split("").filter((l): l is keyof typeof AXES => l in AXES);
  // the center handle (uniform) has no side: it stays a plain scale
  if (letters.length === 0 || controls.axis === "XYZ") return null;
  const bounds = localBounds(object, contents);
  if (bounds.isEmpty()) return null;
  const quaternion = object.getWorldQuaternion(new THREE.Quaternion());
  const grabbed = (controls as unknown as { pointStart: THREE.Vector3 }).pointStart;
  const axes = letters.map((letter): ExtendAxis => {
    const axis = AXES[letter];
    const side = grabbed.dot(UNIT[axis].clone().applyQuaternion(quaternion)) >= 0 ? 1 : -1;
    const [min, max] = [bounds.min.getComponent(axis), bounds.max.getComponent(axis)];
    return { axis, side, anchor: side > 0 ? min : max, size: max - min };
  });
  return { axes, position: object.position.clone() };
}

/** during the drag: the grabbed face follows the pointer, the anchor face stays put */
function applyExtend(
  controls: TransformControls,
  object: THREE.Object3D,
  drag: ExtendDrag,
  snap: boolean,
) {
  const { pointStart, pointEnd } = controls as unknown as {
    pointStart: THREE.Vector3;
    pointEnd: THREE.Vector3;
  };
  const moved = pointEnd.clone().sub(pointStart);
  const quaternion = object.getWorldQuaternion(new THREE.Quaternion());
  object.position.copy(drag.position);
  for (const { axis, side, anchor, size } of drag.axes) {
    let length = size + side * moved.dot(UNIT[axis].clone().applyQuaternion(quaternion));
    if (snap) length = Math.round(length / SNAP.translate) * SNAP.translate;
    // a commit keeps each factor within 1/10..10x (applyScale)
    const factor = Math.min(10, Math.max(0.1, length / size));
    object.scale.setComponent(axis, factor);
    object.position.addScaledVector(
      UNIT[axis].clone().applyQuaternion(object.quaternion),
      (1 - factor) * anchor,
    );
  }
}

/** after an extend commits, the rebuilt item may differ a little (generators round their dimensions, walls keep
 * their thickness): slide it so each anchor face lands exactly where it was, in the same undo step */
function settleExtend(
  viewer: NonNullable<ReturnType<typeof useViewer>>,
  id: string,
  axes: ExtendAxis[],
  targets: number[],
  step: string,
) {
  requestAnimationFrame(() => {
    const object = viewer.scene.getObjectByName("world")?.children.find((o) =>
      o.userData.itemId === id
    );
    if (!object) return;
    const bounds = localBounds(object, [object]);
    const shift = new THREE.Vector3();
    axes.forEach(({ axis, side }, i) => {
      const direction = UNIT[axis].clone().applyQuaternion(object.quaternion);
      const face = object.position.dot(direction) +
        object.scale.getComponent(axis) *
          (side > 0 ? bounds.min.getComponent(axis) : bounds.max.getComponent(axis));
      shift.addScaledVector(direction, targets[i] - face);
    });
    if (shift.length() < 1e-4) return;
    edit((p) => ({
      ...p,
      items: p.items.map((item) =>
        item.id === id
          ? {
            ...item,
            position: item.position.map((v, i) =>
              Math.round((v + shift.getComponent(i)) * 1000) / 1000
            ) as Vec3,
          }
          : item
      ),
    }), step);
  });
}

function Gizmo() {
  const viewer = useViewer();
  const selected = useEditor((s) => s.selected);
  const selection = useEditor((s) => s.selection);
  const gizmo = useEditor((s) => s.gizmo);
  const snap = useEditor((s) => s.snap);
  const project = useEditor((s) => s.project);
  // while clicking out a path, the gizmo would swallow clicks that land on it
  const drawing = useEditor((s) => Boolean(s.drawingPath || s.navTool));
  const controlsRef = useRef<TransformControls | null>(null);
  // several selected: the gizmo moves this pivot, and the members follow it
  const pivot = useRef(new THREE.Object3D());
  const members = useRef<{ object: THREE.Object3D; start: THREE.Matrix4 }[]>([]);
  const pivotStart = useRef(new THREE.Matrix4());
  const extend = useRef<ExtendDrag | null>(null);
  const gizmoRef = useRef(gizmo);
  gizmoRef.current = gizmo;
  const snapRef = useRef(snap);
  snapRef.current = snap;

  useEffect(() => {
    if (!viewer) return;
    const controls = new TransformControls(viewer.camera, viewer.canvas);
    controls.setSpace("local");
    const helper = controls.getHelper();
    viewer.scene.add(helper);
    viewer.scene.add(pivot.current);
    viewer.setOnTop(helper, true);
    // drawing on top moves the helper to its own layer; let the gizmo's own picking ray see every layer
    controls.getRaycaster().layers.enableAll();
    controls.addEventListener("change", () => viewer.requestRender());
    controls.addEventListener("objectChange", () => {
      if (extend.current && controls.object) {
        applyExtend(controls, controls.object, extend.current, snapRef.current);
      }
      if (controls.object !== pivot.current) return;
      pivot.current.updateMatrix();
      const delta = pivot.current.matrix.clone().multiply(pivotStart.current.clone().invert());
      for (const { object, start } of members.current) {
        delta.clone().multiply(start).decompose(object.position, object.quaternion, object.scale);
      }
    });
    controls.addEventListener("dragging-changed", (event) => {
      const dragging = Boolean((event as unknown as { value: boolean }).value);
      viewer.controls.enabled = !dragging;
      (viewer as unknown as { gizmoDragging?: boolean }).gizmoDragging = dragging;
      const object = controls.object;
      if (dragging) {
        if (object === pivot.current) {
          pivot.current.updateMatrix();
          pivotStart.current.copy(pivot.current.matrix);
          for (const m of members.current) m.object.updateMatrix(), m.start.copy(m.object.matrix);
        }
        extend.current = object && gizmoRef.current === "extend"
          ? startExtend(
            controls,
            object,
            object === pivot.current ? members.current.map((m) => m.object) : [object],
          )
          : null;
        return;
      }
      const extended = extend.current;
      extend.current = null;
      // drag ended: write the poses back to the items (all members in one undo step)
      if (object === pivot.current) {
        const byId = new Map(
          members.current.map((m) => [m.object.userData.itemId as string, m.object]),
        );
        updateItems((item) => (byId.has(item.id) ? posedFrom(byId.get(item.id)!, item) : null));
        return;
      }
      const id = object?.userData.itemId as string | undefined;
      const item = getState().project.items.find((i) => i.id === id);
      if (!object || !item) return;
      if (!extended) {
        updateItem(item.id, (current) => posedFrom(object, current));
        return;
      }
      // where each anchor face is now, along its axis (the commit and its settling are one undo step)
      const targets = extended.axes.map(({ axis, anchor }) =>
        object.position.dot(UNIT[axis].clone().applyQuaternion(object.quaternion)) +
        object.scale.getComponent(axis) * anchor
      );
      const step = `extend-${crypto.randomUUID()}`;
      edit((p) => ({
        ...p,
        items: p.items.map((i) => (i.id === item.id ? posedFrom(object, i) : i)),
      }), step);
      settleExtend(viewer, item.id, extended.axes, targets, step);
    });
    controlsRef.current = controls;
    (globalThis as unknown as { dimWorldBuilderGizmo?: TransformControls }).dimWorldBuilderGizmo =
      controls;
    return () => {
      controls.detach();
      viewer.scene.remove(helper);
      viewer.scene.remove(pivot.current);
      controls.dispose();
      viewer.controls.enabled = true;
    };
  }, [viewer]);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls || !viewer) return;
    controls.setMode(gizmo === "extend" ? "scale" : gizmo);
    // things in a world turn about the vertical: rotate is the yaw ring (exact roll/pitch stay in the inspector)
    controls.showX = gizmo !== "rotate";
    controls.showY = gizmo !== "rotate";
    controls.setTranslationSnap(snap ? SNAP.translate : null);
    controls.setRotationSnap(snap ? SNAP.rotate : null);
    controls.setScaleSnap(snap ? SNAP.scale : null);
    // the world layer rebuilds its objects on every project change: find the selected ones afresh
    const world = viewer.scene.getObjectByName("world");
    const find = (id: string) => world?.children.find((o) => o.userData.itemId === id);
    const target = selected ? find(selected) : undefined;
    const several = selection.map(find).filter((o): o is THREE.Object3D => Boolean(o));
    if (several.length > 1 && !drawing) {
      // the pivot sits on the last-clicked one, square to the world
      const at = (target ?? several[0]).position;
      pivot.current.position.copy(at);
      pivot.current.quaternion.identity();
      pivot.current.scale.set(1, 1, 1);
      members.current = several.map((object) => ({ object, start: object.matrix.clone() }));
      controls.attach(pivot.current);
    } else if (target && !drawing) {
      members.current = [];
      controls.attach(target);
    } else controls.detach();
    // a crisp white outline on everything selected (nothing is added when nothing is)
    const outlined: THREE.Mesh[] = [];
    for (const object of several) {
      object.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || !mesh.visible) return;
        if (mesh.material instanceof THREE.MeshBasicMaterial || mesh.userData.outline) return;
        outlined.push(mesh);
      });
    }
    // added after the traversal (adding while traversing would outline the outlines); edges cached per geometry
    const shells = outlined.map((mesh) => {
      let edges = outlineEdges.get(mesh.geometry);
      if (!edges) {
        outlineEdges.set(mesh.geometry, edges = new THREE.EdgesGeometry(mesh.geometry, 35));
      }
      const shell = new THREE.LineSegments(edges, OUTLINE);
      shell.userData.outline = true;
      shell.raycast = () => {};
      mesh.add(shell);
      return shell;
    });
    viewer.requestRender();
    return () => {
      for (const shell of shells) shell.removeFromParent();
    };
  }, [viewer, selected, selection, gizmo, snap, project, drawing]);
  return null;
}

/** the selected item's mover path: a line through its waypoints (closed for a loop) and a dot on each */
function MoverPaths() {
  const project = useEditor((s) => s.project);
  const selected = useEditor((s) => s.selected);
  const drawing = useEditor((s) => s.drawingPath);
  useLayer(() => {
    const item = project.items.find((i) => i.id === selected);
    const mover = item?.mover;
    if (!item || !mover || mover.waypoints.length === 0) return null;
    const lift = project.floors.find((f) => f.id === item.floor)?.elevation ?? 0;
    const points = mover.waypoints.map((w) => new THREE.Vector3(w[0], w[1], w[2] + lift + 0.05));
    if (mover.mode === "loop" && points.length > 2) points.push(points[0].clone());
    const root = new THREE.Group();
    const color = themeColor(drawing ? "var(--warn)" : "var(--primary)");
    root.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color }),
      ),
    );
    for (const p of points) {
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 16, 8),
        new THREE.MeshBasicMaterial({ color }),
      );
      dot.position.copy(p);
      root.add(dot);
    }
    return { root, dispose: () => disposeObject(root) };
  }, [project, selected, drawing]);
  useEffect(() => () => setDrawingPath(null), []);
  return null;
}

/**
 * Every floor drawn where it is, editor only (never exported): its outline (its slab's, or around its items), a
 * faint plane when it has no slab, a label with its name and height, and the floor being edited in the accent color.
 * The lowest floor, when it sits above the ground, stands on posts down to it, so a floor up in the air is plain.
 */
function FloorMarkers() {
  const floors = useEditor((s) => s.project.floors);
  const items = useEditor((s) => s.project.items);
  const active = useEditor((s) => s.project.activeFloor);
  useLayer(() => {
    const root = new THREE.Group();
    const accent = themeColor("var(--primary)");
    const muted = themeColor("var(--muted, #888)");
    const lowest = Math.min(...floors.map((f) => f.elevation));
    for (const floor of floors) {
      let [x0, y0, x1, y1] = [-4, -4, 4, 4];
      if (floor.slab) {
        const { center: [cx, cy], sizeX, sizeY } = floor.slab;
        [x0, y0, x1, y1] = [cx - sizeX / 2, cy - sizeY / 2, cx + sizeX / 2, cy + sizeY / 2];
      } else {
        const own = items.filter((i) => i.floor === floor.id);
        if (own.length) {
          x0 = Math.min(...own.map((i) => i.position[0])) - 2;
          y0 = Math.min(...own.map((i) => i.position[1])) - 2;
          x1 = Math.max(...own.map((i) => i.position[0])) + 2;
          y1 = Math.max(...own.map((i) => i.position[1])) + 2;
        }
      }
      const z = floor.elevation + 0.01;
      const color = floor.id === active ? accent : muted;
      const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) =>
        new THREE.Vector3(x, y, z)
      );
      const outline = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(corners),
        new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: floor.id === active ? 0.9 : 0.45,
        }),
      );
      root.add(outline);
      if (!floor.slab) {
        const plane = new THREE.Mesh(
          new THREE.PlaneGeometry(x1 - x0, y1 - y0),
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: floor.id === active ? 0.08 : 0.04,
            depthWrite: false,
            side: THREE.DoubleSide,
          }),
        );
        plane.position.set((x0 + x1) / 2, (y0 + y1) / 2, z);
        plane.raycast = () => {};
        root.add(plane);
      }
      if (floor.elevation === lowest && lowest > 0.05) {
        const posts = corners.flatMap((c) => [c, new THREE.Vector3(c.x, c.y, 0)]);
        const lines = new THREE.LineSegments(
          new THREE.BufferGeometry().setFromPoints(posts),
          new THREE.LineDashedMaterial({ color: muted, dashSize: 0.3, gapSize: 0.2 }),
        );
        lines.computeLineDistances();
        root.add(lines);
      }
      const tag = document.createElement("div");
      tag.textContent = `${floor.name} · ${floor.elevation.toFixed(1)} m${
        floor.slab ? "" : " · no slab"
      }`;
      tag.style.cssText =
        `font: 500 11px system-ui; padding: 2px 6px; border-radius: 4px; pointer-events: none;
        color: white; background: ${floor.id === active ? "var(--primary)" : "rgba(40,44,52,.7)"}`;
      const label = new CSS2DObject(tag);
      label.position.set(x0, y0, z);
      root.add(label);
    }
    return {
      root,
      dispose: () => {
        root.traverse((o) => {
          if (o instanceof CSS2DObject) o.element.remove();
        });
        disposeObject(root);
      },
    };
  }, [floors, items, active]);
  return null;
}

/** the nav test (mapping path, goals) and the spawn points, drawn over the world */
function NavOverlay() {
  const project = useEditor((s) => s.project);
  const tool = useEditor((s) => s.navTool);
  const selectedLabel = useEditor((s) => s.selectedLabel);
  const labelTarget = useEditor((s) => s.labelTarget);
  useLayer(() => {
    const root = new THREE.Group();
    const lift = (floor: string) => project.floors.find((f) => f.id === floor)?.elevation ?? 0;
    const spawnColor = themeColor("var(--info)");
    for (const spawn of project.spawns) {
      const arrow = new THREE.ArrowHelper(
        new THREE.Vector3(Math.cos(spawn.yaw), Math.sin(spawn.yaw), 0),
        new THREE.Vector3(
          spawn.position[0],
          spawn.position[1],
          spawn.position[2] + lift(spawn.floor) + 0.05,
        ),
        0.7,
        spawnColor,
        0.25,
        0.18,
      );
      root.add(arrow);
    }
    // the labels: paths dashed, areas outlined (closed, with a faint fill), points as a pin; goals as a flag with
    // their reach ring; the selected one in the accent color
    for (const label of project.annotations ?? []) {
      const up = lift(label.floor) + 0.04;
      const chosen = label.id === selectedLabel || label.id === labelTarget;
      const color = themeColor(
        chosen ? "var(--warn)" : label.tags.includes(NAV_GOAL) ? "var(--ok)" : "var(--primary)",
      );
      const at = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2] + up);
      let anchor: THREE.Vector3 | null = null;
      if (label.kind === "point" && label.position) {
        const base = at(label.position);
        anchor = base.clone().setZ(base.z + 1.05);
        const tolerance = Number(label.props?.tolerance ?? 0.25);
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(tolerance * 0.9, tolerance, 48),
          new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }),
        );
        ring.position.copy(base);
        const pole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.02, 0.02, 1, 8).rotateX(Math.PI / 2),
          new THREE.MeshBasicMaterial({ color }),
        );
        pole.position.copy(base).setZ(base.z + 0.5);
        const flag = new THREE.Mesh(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 1),
            new THREE.Vector3(0.35, 0, 0.88),
            new THREE.Vector3(0, 0, 0.76),
          ]),
          new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }),
        );
        flag.position.copy(base);
        root.add(ring, pole, flag);
      } else if (label.points?.length) {
        const points = label.points.map(at);
        anchor = points[0].clone().setZ(points[0].z + 0.3);
        const outline = label.kind === "area" && points.length > 2
          ? [...points, points[0]]
          : points;
        if (outline.length > 1) {
          const line = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(outline),
            label.kind === "path"
              ? new THREE.LineDashedMaterial({ color, dashSize: 0.25, gapSize: 0.15 })
              : new THREE.LineBasicMaterial({ color }),
          );
          line.computeLineDistances();
          root.add(line);
        }
        if (label.kind === "area" && points.length > 2) {
          const shape = new THREE.Shape(points.map((p) => new THREE.Vector2(p.x, p.y)));
          const fill = new THREE.Mesh(
            new THREE.ShapeGeometry(shape),
            new THREE.MeshBasicMaterial({
              color,
              transparent: true,
              opacity: 0.12,
              depthWrite: false,
              side: THREE.DoubleSide,
            }),
          );
          fill.position.z = points[0].z;
          root.add(fill);
        }
        for (const p of points) {
          const dot = new THREE.Mesh(
            new THREE.SphereGeometry(0.07, 12, 6),
            new THREE.MeshBasicMaterial({ color }),
          );
          dot.position.copy(p);
          root.add(dot);
        }
      }
      if (anchor) {
        const tag = document.createElement("div");
        tag.textContent = label.label;
        tag.style.cssText =
          `font: 500 11px system-ui; padding: 1px 5px; border-radius: 4px; pointer-events: none;
          color: white; background: ${chosen ? "var(--warn, #c80)" : "rgba(40,44,52,.75)"}`;
        const text = new CSS2DObject(tag);
        text.position.copy(anchor);
        root.add(text);
      }
    }
    return {
      root,
      dispose: () => {
        root.traverse((o) => {
          if (o instanceof CSS2DObject) o.element.remove();
        });
        disposeObject(root);
      },
    };
  }, [project, tool, selectedLabel, labelTarget]);
  return null;
}

/** viewer mode: the robot and its lidar, live from the running blueprint */
function LiveRobot() {
  const showLidar = useEditor((s) => s.showCollision);
  return (
    <>
      <TfFeed />
      <Go2Model />
      {showLidar && (
        <PointCloud topic="dimos/pointcloud/sensor_msgs.PointCloud2" style="voxel" size={0.04} />
      )}
    </>
  );
}

interface Rig {
  root: string;
  joints: { name: string; body: string; axis: Vec3; bodyQuat: Quat }[];
}

/**
 * The Go2 (Menagerie's meshes, baked by tools/make_go2_glb.py), posed by TF (world -> go2/base) and its legs by the
 * connection's motor_states joint angles.
 */
function Go2Model() {
  const tf = useTf();
  const angles = useRef(new Map<string, number>());
  useSubscription(
    "dimos/motor_states/sensor_msgs.JointState",
    (msg: { name: string[]; position: number[] }) => {
      msg.name.forEach((name, i) =>
        angles.current.set(name.replace(/^go2\//, ""), msg.position[i])
      );
    },
    { maxHz: 30 },
  );
  useLayer(({ viewer }) => {
    const root = new THREE.Group();
    root.visible = false;
    let rig: Rig | null = null;
    const nodes = new Map<string, THREE.Object3D>();
    Promise.all([
      new GLTFLoader().loadAsync("files/robots/go2/go2.glb"),
      fetch("files/robots/go2/rig.json").then((r) => r.json() as Promise<Rig>),
    ]).then(([gltf, loadedRig]) => {
      rig = loadedRig;
      gltf.scene.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          const material = child.material as THREE.MeshStandardMaterial;
          material.roughness = 0.55;
        }
      });
      for (const joint of rig.joints) {
        const node = gltf.scene.getObjectByName(joint.body);
        if (node) nodes.set(joint.name, node);
      }
      root.add(gltf.scene);
      viewer.requestRender();
    }).catch(() => {});
    const axis = new THREE.Vector3();
    const spin = new THREE.Quaternion();
    return {
      root,
      update: () => {
        const pose = tf?.lookup("go2/base", "world");
        root.visible = Boolean(pose && rig);
        if (!pose || !rig) return;
        pose.decompose(root.position, root.quaternion, new THREE.Vector3());
        for (const joint of rig.joints) {
          const node = nodes.get(joint.name);
          const angle = angles.current.get(joint.name);
          if (!node || angle === undefined) continue;
          axis.set(...joint.axis);
          node.quaternion.set(...joint.bodyQuat).multiply(spin.setFromAxisAngle(axis, angle));
        }
      },
      dispose: () => disposeObject(root),
    };
  }, [tf]);
  return null;
}

export type { Project };

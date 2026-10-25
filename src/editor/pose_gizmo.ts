// From dim-controller (frontend/src/core/poseGizmo.ts, the arm target's gizmo), with snapping, cancel and every layer
// picked added for World Builder's items.
// The arm target's gizmo: one thick arrow per axis (moves along it), a square between each pair of arrows (moves in
// their plane, the orientation left to the IK) and a short arc between each pair of arrow heads (rotates about the third axis), in the handle's own axes. Each arrow points whichever way faces the camera, so the
// shown one is the visible one; the arcs follow the arrows. Shift aligns it with the robot base's axes. Drawn on top of the scene, at a fixed size in the world or (scalesWithView) on screen.
import * as THREE from "three";

const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
const COLORS = [0xe5484d, 0x30a46c, 0x3e63dd];
/** the arrow's length on screen (CSS px), when it scales with the view */
const SCREEN_PX = 110;
/** the arrow's length in the world (m), when it doesn't */
const WORLD_M = 0.22;
const ARC_RADIUS = 0.72;
const ARC_SPAN = THREE.MathUtils.degToRad(40);
/** an arrow flips only once the camera is clearly on the other side (no flicker when it's edge-on) */
const FLIP_MARGIN = 0.08;

type Part = {
  kind: "move" | "plane" | "rotate";
  axis: number;
  outlines: THREE.Mesh[];
  pick: THREE.Mesh;
};

export class PoseGizmo {
  readonly object = new THREE.Group();
  enabled = true;
  /** snap moves to this many meters and turns to this many radians (null: free) */
  snap: { distance: number | null; angle: number | null } = { distance: null, angle: null };
  /** one size on screen (zoom doesn't change it); false: WORLD_M long in the world */
  scalesWithView = false;
  #parts: Part[] = [];
  #arrows: THREE.Group[] = [];
  #arcs: THREE.Group[] = [];
  #squares: THREE.Group[] = [];
  #signs = [1, 1, 1];
  #hovered: Part | null = null;
  #drag: {
    part: Part;
    pointerId: number;
    startWorld: THREE.Vector3;
    startQuat: THREE.Quaternion;
    axis: THREE.Vector3;
    startAlong: number;
    startVector: THREE.Vector3 | null;
    startX: number;
  } | null = null;
  #raycaster = new THREE.Raycaster();

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    readonly canvas: HTMLCanvasElement,
    public handle: THREE.Object3D,
    readonly events: {
      change: () => void;
      dragging: (dragging: boolean) => void;
      render: () => void;
    },
  ) {
    this.object.renderOrder = 1000;
    // the viewer draws on-top objects on their own layer
    this.#raycaster.layers.enableAll();
    for (let axis = 0; axis < 3; axis++) {
      this.#arrows.push(this.#arrow(axis));
      this.#arcs.push(this.#arc(axis));
      this.#squares.push(this.#square(axis));
    }
    // capture: ahead of the orbit controls' own pointerdown on the same canvas
    canvas.addEventListener("pointerdown", this.#down, true);
    canvas.addEventListener("pointermove", this.#move);
    canvas.addEventListener("pointerup", this.#up);
    canvas.addEventListener("pointercancel", this.#up);
    addEventListener("keydown", this.#shift);
    addEventListener("keyup", this.#shift);
    addEventListener("blur", this.#shift);
  }

  /** Shift held: the gizmo's axes are the robot base's (z up), not the hand's */
  #aligned = false;
  #shift = (event: Event) => {
    const held = event instanceof KeyboardEvent && event.shiftKey;
    if (held !== this.#aligned) {
      this.#aligned = held;
      this.events.render();
    }
  };

  get dragging(): boolean {
    return this.#drag !== null;
  }

  /** a square's drag: only the position is meant, the orientation is whatever reaches it */
  get positionOnly(): boolean {
    return this.#drag?.part.kind === "plane";
  }

  #material(color: number): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({
      color,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
      toneMapped: false,
    });
  }

  // both sides: a square is grabbed from either face
  #pickMaterial = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
    colorWrite: false,
    side: THREE.DoubleSide,
  });
  #outlineMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  /** `geometry` with a white, slightly larger `outline` drawn behind it while hovered */
  #outlined(
    geometry: THREE.BufferGeometry,
    outline: THREE.BufferGeometry,
    material: THREE.Material,
  ): [THREE.Mesh, THREE.Mesh] {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 1001;
    const shell = new THREE.Mesh(outline, this.#outlineMaterial);
    shell.renderOrder = 1000;
    shell.visible = false;
    mesh.add(shell);
    return [mesh, shell];
  }

  /** along +x, turned onto its axis; its sign is the group's scale */
  #arrow(axis: number): THREE.Group {
    const group = new THREE.Group();
    const material = this.#material(COLORS[axis]);
    const [shaft, shaftOutline] = this.#outlined(
      new THREE.CylinderGeometry(0.026, 0.026, 0.78, 12),
      new THREE.CylinderGeometry(0.045, 0.045, 0.8, 12),
      material,
    );
    shaft.position.y = 0.39;
    const [head, headOutline] = this.#outlined(
      new THREE.ConeGeometry(0.075, 0.19, 16),
      new THREE.ConeGeometry(0.105, 0.25, 16),
      material,
    );
    head.position.y = 0.875;
    const pick = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 1.05, 8),
      this.#pickMaterial,
    );
    pick.position.y = 0.52;
    const along = new THREE.Group();
    along.add(shaft, head, pick);
    // the meshes are built along +y
    along.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), AXES[axis]);
    group.add(along);
    this.object.add(group);
    this.#parts.push({ kind: "move", axis, outlines: [shaftOutline, headOutline], pick });
    return group;
  }

  /** normal to `axis`, in the corner between the other two arrows */
  #square(axis: number): THREE.Group {
    const group = new THREE.Group();
    const material = this.#material(COLORS[axis]);
    material.side = THREE.DoubleSide;
    material.opacity = 0.55;
    const [square, squareOutline] = this.#outlined(
      new THREE.PlaneGeometry(0.28, 0.28),
      new THREE.PlaneGeometry(0.32, 0.32),
      material,
    );
    square.position.set(0.34, 0.34, 0);
    const pick = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), this.#pickMaterial);
    pick.position.copy(square.position);
    group.add(square, pick);
    group.matrixAutoUpdate = false;
    this.object.add(group);
    this.#parts.push({ kind: "plane", axis, outlines: [squareOutline], pick });
    return group;
  }

  /** about `axis`, in the plane of the other two, centered between their arrow heads */
  #arc(axis: number): THREE.Group {
    const group = new THREE.Group();
    const start = Math.PI / 4 - ARC_SPAN / 2;
    const tube = new THREE.TorusGeometry(ARC_RADIUS, 0.028, 8, 24, ARC_SPAN);
    tube.rotateZ(start);
    const tubeOutline = new THREE.TorusGeometry(ARC_RADIUS, 0.05, 8, 24, ARC_SPAN);
    tubeOutline.rotateZ(start);
    const material = this.#material(COLORS[axis]);
    const [arc, arcOutline] = this.#outlined(tube, tubeOutline, material);
    const pickTube = new THREE.TorusGeometry(ARC_RADIUS, 0.1, 6, 16, ARC_SPAN + 0.15);
    pickTube.rotateZ(start - 0.075);
    const pick = new THREE.Mesh(pickTube, this.#pickMaterial);
    // a small arrowhead at each end, along the arc: it turns both ways
    const heads = [[start, -1], [start + ARC_SPAN, 1]].map(([angle, way]) => {
      const [head, headOutline] = this.#outlined(
        new THREE.ConeGeometry(0.055, 0.13, 12),
        new THREE.ConeGeometry(0.085, 0.19, 12),
        material,
      );
      head.userData.outline = headOutline;
      head.position.set(ARC_RADIUS * Math.cos(angle), ARC_RADIUS * Math.sin(angle), 0);
      head.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(-Math.sin(angle) * way, Math.cos(angle) * way, 0),
      );
      return head;
    });
    group.add(arc, ...heads, pick);
    const outlines = [arcOutline, ...heads.map((head) => head.userData.outline as THREE.Mesh)];
    group.matrixAutoUpdate = false;
    this.object.add(group);
    this.#parts.push({ kind: "rotate", axis, outlines, pick });
    return group;
  }

  /** Each frame: at the handle, sized for the screen, each arrow toward the camera (not while dragging). */
  update() {
    this.object.visible = this.enabled;
    if (!this.enabled) {
      return;
    }
    this.handle.updateWorldMatrix(true, false);
    const origin = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    this.handle.matrixWorld.decompose(origin, rotation, new THREE.Vector3());
    if (this.#aligned && this.handle.parent) {
      this.handle.parent.getWorldQuaternion(rotation);
    }
    const distance = this.camera.position.distanceTo(origin);
    const height = Math.max(1, this.canvas.clientHeight);
    const scale = this.scalesWithView
      ? distance * 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * SCREEN_PX / height
      : WORLD_M;
    this.object.position.copy(origin);
    this.object.quaternion.copy(rotation);
    this.object.scale.setScalar(scale);
    if (!this.#drag) {
      const toCamera = this.camera.position.clone().sub(origin).normalize();
      for (let axis = 0; axis < 3; axis++) {
        const facing = AXES[axis].clone().applyQuaternion(rotation).dot(toCamera);
        if (facing * this.#signs[axis] < -FLIP_MARGIN) {
          this.#signs[axis] = -this.#signs[axis];
        }
      }
    }
    for (let axis = 0; axis < 3; axis++) {
      this.#arrows[axis].scale.setScalar(1).setComponent(axis, this.#signs[axis]);
      const [b, c] = [(axis + 1) % 3, (axis + 2) % 3];
      const u = AXES[b].clone().multiplyScalar(this.#signs[b]);
      const v = AXES[c].clone().multiplyScalar(this.#signs[c]);
      for (const group of [this.#arcs[axis], this.#squares[axis]]) {
        group.matrix.makeBasis(u, v, u.clone().cross(v));
        group.matrixWorldNeedsUpdate = true;
      }
    }
  }

  #ray(event: PointerEvent): THREE.Ray {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.#raycaster.setFromCamera(ndc, this.camera);
    return this.#raycaster.ray;
  }

  #hit(event: PointerEvent): Part | null {
    if (!this.enabled || !this.object.visible) {
      return null;
    }
    this.object.updateMatrixWorld(true);
    this.#ray(event);
    const hits = this.#raycaster.intersectObjects(this.#parts.map((part) => part.pick), false);
    // arrows, then squares, then arcs where they overlap
    const rank = (object: THREE.Object3D) =>
      ["move", "plane", "rotate"].indexOf(this.#partOf(object)?.kind ?? "rotate");
    hits.sort((a, b) => rank(a.object) - rank(b.object) || a.distance - b.distance);
    return hits.length ? this.#partOf(hits[0].object) : null;
  }

  #partOf(object: THREE.Object3D): Part | null {
    return this.#parts.find((part) => part.pick === object) ?? null;
  }

  #highlight(part: Part | null) {
    if (part === this.#hovered) {
      return;
    }
    for (const outline of this.#hovered?.outlines ?? []) {
      outline.visible = false;
    }
    for (const outline of part?.outlines ?? []) {
      outline.visible = true;
    }
    this.#hovered = part;
    this.canvas.style.cursor = part ? (part.kind === "rotate" ? "grab" : "move") : "";
    this.events.render();
  }

  /** where the pointer's ray passes closest to the line through `origin` along `axis` (its distance along it) */
  #along(ray: THREE.Ray, origin: THREE.Vector3, axis: THREE.Vector3): number {
    const w = origin.clone().sub(ray.origin);
    const b = axis.dot(ray.direction);
    const denominator = 1 - b * b;
    if (denominator < 1e-6) {
      return 0;
    }
    return (b * w.dot(ray.direction) - w.dot(axis)) / denominator;
  }

  /** the pointer's ray on the plane through `origin` normal to `axis`, from the origin; null when edge-on */
  #onPlane(ray: THREE.Ray, origin: THREE.Vector3, axis: THREE.Vector3): THREE.Vector3 | null {
    if (Math.abs(ray.direction.dot(axis)) < 0.15) {
      return null;
    }
    const point = ray.intersectPlane(
      new THREE.Plane().setFromNormalAndCoplanarPoint(axis, origin),
      new THREE.Vector3(),
    );
    return point ? point.sub(origin) : null;
  }

  #down = (event: PointerEvent) => {
    if (event.button !== 0) {
      return;
    }
    const part = this.#hit(event);
    if (!part) {
      return;
    }
    event.stopImmediatePropagation();
    event.preventDefault();
    this.canvas.setPointerCapture(event.pointerId);
    const startWorld = new THREE.Vector3();
    const startQuat = new THREE.Quaternion();
    this.handle.matrixWorld.decompose(startWorld, startQuat, new THREE.Vector3());
    // along the axes as shown (the hand's, or with Shift the base's)
    const axis = AXES[part.axis].clone().applyQuaternion(this.object.quaternion);
    const ray = this.#ray(event);
    this.#drag = {
      part,
      pointerId: event.pointerId,
      startWorld,
      startQuat,
      axis,
      startAlong: this.#along(ray, startWorld, axis),
      startVector: this.#onPlane(ray, startWorld, axis),
      startX: event.clientX,
    };
    this.#highlight(part);
    this.events.dragging(true);
  };

  #move = (event: PointerEvent) => {
    const drag = this.#drag;
    if (!drag) {
      this.#highlight(event.buttons ? this.#hovered : this.#hit(event));
      return;
    }
    if (event.pointerId !== drag.pointerId) {
      return;
    }
    const ray = this.#ray(event);
    const parent = this.handle.parent;
    const step = (
      value: number,
      size: number | null,
    ) => (size ? Math.round(value / size) * size : value);
    if (drag.part.kind === "move") {
      const world = drag.startWorld.clone().addScaledVector(
        drag.axis,
        step(this.#along(ray, drag.startWorld, drag.axis) - drag.startAlong, this.snap.distance),
      );
      this.handle.position.copy(parent ? parent.worldToLocal(world) : world);
    } else if (drag.part.kind === "plane") {
      const now = drag.startVector && this.#onPlane(ray, drag.startWorld, drag.axis);
      if (!now) {
        return;
      }
      const offset = now.sub(drag.startVector!);
      const world = drag.startWorld.clone().add(
        offset.set(
          step(offset.x, this.snap.distance),
          step(offset.y, this.snap.distance),
          step(offset.z, this.snap.distance),
        ),
      );
      this.handle.position.copy(parent ? parent.worldToLocal(world) : world);
    } else {
      const now = drag.startVector && this.#onPlane(ray, drag.startWorld, drag.axis);
      // edge-on: sideways pointer travel turns it instead
      const angle = step(
        drag.startVector && now
          ? Math.atan2(
            drag.startVector.clone().cross(now).dot(drag.axis),
            drag.startVector.dot(now),
          )
          : (event.clientX - drag.startX) * 0.01,
        this.snap.angle,
      );
      const world = new THREE.Quaternion().setFromAxisAngle(drag.axis, angle).multiply(
        drag.startQuat,
      );
      const parentQuat = parent
        ? parent.getWorldQuaternion(new THREE.Quaternion())
        : new THREE.Quaternion();
      this.handle.quaternion.copy(parentQuat.invert().multiply(world));
    }
    this.handle.updateMatrixWorld();
    this.events.change();
    this.events.render();
  };

  #up = (event: PointerEvent) => {
    if (!this.#drag || event.pointerId !== this.#drag.pointerId) {
      return;
    }
    this.#drag = null;
    this.canvas.releasePointerCapture?.(event.pointerId);
    this.#highlight(null);
    this.events.dragging(false);
  };

  /** Esc mid-drag: back to where the drag started, and the drag ends */
  cancel() {
    const drag = this.#drag;
    if (!drag) {
      return;
    }
    const parent = this.handle.parent;
    this.handle.position.copy(
      parent ? parent.worldToLocal(drag.startWorld.clone()) : drag.startWorld,
    );
    const parentQuat = parent
      ? parent.getWorldQuaternion(new THREE.Quaternion())
      : new THREE.Quaternion();
    this.handle.quaternion.copy(parentQuat.invert().multiply(drag.startQuat));
    this.handle.updateMatrixWorld();
    this.events.change();
    this.#up({ pointerId: drag.pointerId } as PointerEvent);
  }

  dispose() {
    this.canvas.removeEventListener("pointerdown", this.#down, true);
    this.canvas.removeEventListener("pointermove", this.#move);
    this.canvas.removeEventListener("pointerup", this.#up);
    this.canvas.removeEventListener("pointercancel", this.#up);
    removeEventListener("keydown", this.#shift);
    removeEventListener("keyup", this.#shift);
    removeEventListener("blur", this.#shift);
    this.object.removeFromParent();
    this.object.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      (mesh.material as THREE.Material | undefined)?.dispose?.();
    });
  }
}

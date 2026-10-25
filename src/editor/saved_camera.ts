// The view each world was last left at, per browser, so a reload (or reopening the world) resumes it
import type { Vec3 } from "../world/types.ts";

export type SavedCamera = { eye: Vec3; target: Vec3; fov: number };

const key = (world: string) => `dim-world-builder.camera.${world}`;

export function savedCamera(world: string): SavedCamera | null {
  try {
    const raw = localStorage.getItem(key(world));
    return raw ? JSON.parse(raw) as SavedCamera : null;
  } catch {
    return null;
  }
}

export function saveCamera(world: string, camera: SavedCamera) {
  try {
    localStorage.setItem(key(world), JSON.stringify(camera));
  } catch {
    // storage blocked: the view just isn't resumed
  }
}

// The app's own server (backend/main.ts), through relative URLs (Desktop serves the page at /apps/<name>/).
import type { Item, MeshAsset, Project, Vec3 } from "./world/types.ts";
import { packageName } from "./world/keys.ts";
import type { Clip } from "./world/clips.ts";

export async function json<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
  }
  return body as T;
}

const send = <T>(method: string, url: string, body: unknown) =>
  json<T>(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export const library = () => json<MeshAsset[]>("api/library");

export const listProjects = () => json<{ projects: string[] }>("api/projects");
// the saved version each world was last loaded or saved at here: a save names it, so the backend can merge in changes made since
const baseVersions = new Map<string, string>();

export async function loadProject(name: string): Promise<Project> {
  const response = await fetch(`api/internal/projects/${encodeURIComponent(name)}`);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
  baseVersions.set(packageName(name), response.headers.get("x-world-version") ?? "");
  return body as Project;
}

export interface SaveResult {
  saved: string;
  alsoSaved?: string;
  version: string;
  /** the world changed since this page's version: the backend merged this page's edits into it; this is the result */
  merged?: Project;
}
/** saves the page's world; throws a SaveConflict when it changed elsewhere and can't be merged */
export async function saveProject(project: Project): Promise<SaveResult> {
  const name = packageName(project.name);
  const base = baseVersions.get(name);
  const query = base === undefined ? "" : `?base=${encodeURIComponent(base)}`;
  const response = await fetch(
    `api/internal/projects/${encodeURIComponent(project.name)}${query}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(project),
    },
  );
  const body = await response.json().catch(() => null);
  if (response.status === 409) throw new SaveConflict(body?.error ?? "changed elsewhere");
  if (!response.ok) throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
  baseVersions.set(name, body.version);
  return body as SaveResult;
}
export class SaveConflict extends Error {}

/** write the project to a .json anywhere (a folder: <name>.json in it); later saves go there too */
export const saveAs = (project: Project, path: string) =>
  send<{ saved: string }>("POST", "api/internal/save-as", { project, path });
/** saved worlds that also save to a file elsewhere: { name: path } */
export const linkedFiles = () => json<Record<string, string>>("api/internal/linked");

export interface ExportResult {
  dir: string;
  name: string;
  files: string[];
  bodies: number;
  movers: number;
}
export const exportWorld = (project: Project, parentDir: string) =>
  send<ExportResult>("POST", "api/export", { project, parentDir });

export const uploadVisual = (dir: string, glb: ArrayBuffer) =>
  json<{ written: string }>(`api/internal/visual?dir=${encodeURIComponent(dir)}`, {
    method: "POST",
    body: glb,
  });

export interface DirListing {
  path: string;
  parent: string;
  home: string;
  dirs: string[];
  /** .json files */
  files: string[];
  /** the dirs that are exported worlds (they have a scene.json) */
  worlds: string[];
  error?: string;
}
/** a saved world by name, a file or export folder by path, or a project / scene.json as JSON; show: false = no Desktop */
export const openWorld = (
  body: { name?: string; path?: string; project?: unknown; show?: boolean },
) => send<{ opened: string; items: number; savesTo?: string }>("POST", "api/open", body);

export const listDirs = (path: string) =>
  json<DirListing>(`api/internal/dirs?path=${encodeURIComponent(path)}`);

export interface CookJob {
  id: string;
  name: string;
  state: "running" | "done" | "failed";
  stage: string;
  progress: number;
  log: string[];
  asset?: MeshAsset;
}
export function startImport(file: File, name: string, height: number | null) {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "glb";
  const query = new URLSearchParams({ name, ext, ...(height ? { height: String(height) } : {}) });
  return json<{ job: string }>(`api/internal/import?${query}`, { method: "POST", body: file });
}
export const importStatus = (job: string) => json<CookJob>(`api/internal/import/${job}`);

/** one item clipping into another (backend: cooker/check_clips.py, MuJoCo contacts), classified (world/clips.ts) */
export type { Clip } from "./world/clips.ts";
export const checkClips = (project: Project) =>
  send<{ clips: Clip[]; problems: number; expected: number; warnings: string[] }>(
    "POST",
    "api/check",
    { project },
  );

/** this page's world and selection, for agents (GET api/selection answers with the latest page's) */
export const reportSelection = (world: string, ids: string[], items: Item[]) =>
  send<{ selected: number }>("POST", "api/internal/selection", { world, ids, items });

/** this page's view, for agents (GET api/camera answers with the latest page's) */
export const reportCamera = (world: string, eye: Vec3, target: Vec3, fov: number) =>
  send<{ ok: boolean }>("POST", "api/internal/camera", { world, eye, target, fov });

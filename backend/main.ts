// dimos-app-server for dim-world-builder: serves the built page and the app's API on the unix socket Desktop gives.
//
// What Desktop passes: one env var, DIMOS_APP (JSON): { name, socket, dataDir, desktopUrl, ... }. Requests arrive with
// /apps/<name> already removed.
//
// The API, as dimos.yaml declares it:
//   POST /api/export                 public: write a project as a dimos world directory (body: { project, parentDir })
//   GET  /api/library                public: every placeable mesh asset (library + cooked imports)
//   GET  /api/projects               public: saved projects
//   POST /api/open                   public: open a world in the user's World Builder (body: { name } | { path } | { project })
//   GET|POST /api/views, POST /api/views/remove   public: a saved world's remembered camera views
//   GET  /api/views/image?name=&view=&width=&height=   public: a PNG of the world from one view (MuJoCo)
//   POST /api/check                  public: items whose collision shapes interpenetrate (clips), as warnings
//   GET  /api/selection              public: the items selected in the most recently active page
//   POST /api/images?name=           public: store a JPEG/PNG (raw body) for image items; returns { id, src }
//   POST /api/internal/selection     private: a page reports its world and selection (body: { world, ids, items })
//   GET|PUT /api/internal/projects/<name>   private: load / autosave one project
//   GET  /api/internal/linked        private: saved worlds that also save to a file elsewhere ({ name: path })
//   POST /api/internal/save-as       private: write the project to a .json anywhere; later saves go there too (body: { project, path })
//   POST /api/internal/import?name=&height=  private: upload a .glb/.gltf/.obj; cooks it in the background
//   GET  /api/internal/import/<job>  private: a cook's progress and result
//   POST /api/internal/visual?dir=   private: the page's baked visual.glb for an export
//   GET  /api/internal/dirs?path=    private: folders (and .json files) under a path (the export and open pickers)
//   GET  /files/library/<id>/<file>, /files/imports/<id>/<file>   private: mesh files
//   GET  /files/images/<id>.<ext>    private: uploaded reference photos

import { exportProject, packageName } from "./export.ts";
import type { ImageParams, Item, MeshAsset, Project, Vec3 } from "../src/world/types.ts";
import { emptyProject } from "../src/world/defaults.ts";
import { testCourse } from "../src/world/examples.ts";
import { clutterYard } from "../src/world/examples_clutter.ts";
import { playground } from "../src/world/examples_playground.ts";
import { keyedProject, slug } from "../src/world/keys.ts";

const app = JSON.parse(Deno.env.get("DIMOS_APP") ?? "{}") as {
  name?: string;
  socket?: string;
  dataDir?: string;
  desktopUrl?: string;
};
const flag = (name: string) => {
  const index = Deno.args.indexOf(`--${name}`);
  return index === -1 ? undefined : Deno.args[index + 1];
};
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const frontend = flag("frontend") ?? `${root}/dist`;
const dataDir = app.dataDir ?? `${root}/.data`;
const libraryDir = `${root}/assets/library`;
const importsDir = `${dataDir}/imports`;
const projectsDir = `${dataDir}/projects`;
const imagesDir = `${dataDir}/images`;
const cookerDir = `${root}/cooker`;
const home = Deno.env.get("HOME") ?? "/";
const desktopUrl = app.desktopUrl ?? "http://127.0.0.1:5555";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch {
    return fallback;
  }
}

/** library assets ship with the app; imports are cooked into dataDir. `base` is the page's URL for their files. */
async function assets(): Promise<{ list: MeshAsset[]; dirs: Record<string, string> }> {
  const list: MeshAsset[] = [];
  const dirs: Record<string, string> = {};
  for (const asset of await readJson<MeshAsset[]>(`${libraryDir}/index.json`, [])) {
    list.push({ ...asset, base: `files/library/${asset.id}` });
    dirs[asset.id] = `${libraryDir}/${asset.id}`;
  }
  try {
    for await (const entry of Deno.readDir(importsDir)) {
      if (!entry.isDirectory) continue;
      const meta = await readJson<MeshAsset | null>(`${importsDir}/${entry.name}/meta.json`, null);
      if (!meta) continue;
      list.push({
        ...meta,
        id: entry.name,
        category: "imported",
        base: `files/imports/${entry.name}`,
      });
      dirs[entry.name] = `${importsDir}/${entry.name}`;
    }
  } catch {
    // no imports yet
  }
  return { list, dirs };
}

// ── cooking an upload: the app's own Python (cooker/, uv-locked), one job at a time per upload ──

interface CookJob {
  id: string;
  name: string;
  state: "running" | "done" | "failed";
  stage: string;
  progress: number;
  log: string[];
  asset?: MeshAsset;
}
const jobs = new Map<string, CookJob>();

function uvBinary(): string {
  return flag("uv") ?? Deno.env.get("DIM_WORLD_BUILDER_UV") ?? "uv";
}

async function cook(job: CookJob, input: string, targetHeight: number | null) {
  const out = `${importsDir}/${job.id}`;
  const args = [
    "run",
    "--frozen",
    "--project",
    cookerDir,
    "python",
    `${cookerDir}/cook.py`,
    input,
    out,
    "--id",
    job.id,
    "--name",
    job.name,
    "--category",
    "imported",
    "--validate",
    "--thumb",
  ];
  if (targetHeight) args.push("--target-height", String(targetHeight));
  const command = new Deno.Command(uvBinary(), {
    args,
    stdout: "piped",
    stderr: "piped",
    env: { UV_PROJECT_ENVIRONMENT: `${dataDir}/cooker-venv`, PYTHONUNBUFFERED: "1" },
  });
  const child = command.spawn();
  const decoder = new TextDecoder();
  const read = async (stream: ReadableStream<Uint8Array>) => {
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        job.log.push(line);
        try {
          const event = JSON.parse(line);
          if (event.stage) job.stage = event.stage;
          if (typeof event.progress === "number") job.progress = event.progress;
        } catch {
          // a plain log line (uv installing the environment, warnings)
        }
      }
    }
  };
  await Promise.all([read(child.stdout), read(child.stderr)]);
  const status = await child.status;
  await Deno.remove(input).catch(() => {});
  if (status.success) {
    const meta = await readJson<MeshAsset | null>(`${out}/meta.json`, null);
    job.asset = meta
      ? { ...meta, id: job.id, category: "imported", base: `files/imports/${job.id}` }
      : undefined;
    job.state = job.asset ? "done" : "failed";
    job.stage = job.asset ? "cooked" : "no meta.json written";
    job.progress = 1;
  } else {
    job.state = "failed";
    job.stage = status.code === 2 ? "quality check failed" : `cooker exited ${status.code}`;
    await Deno.remove(out, { recursive: true }).catch(() => {});
  }
}

// ── the clip check: export to a scratch folder, then MuJoCo reports every interpenetrating pair (cooker/check_clips.py) ──

interface ClipReport {
  tolerance_m?: number;
  clips: unknown[];
  warnings: string[];
}

async function clipCheck(project: Project, tolerance = 0.02): Promise<ClipReport> {
  const parent = `${dataDir}/checks/${crypto.randomUUID()}`;
  try {
    const { list, dirs } = await assets();
    const result = await exportProject(
      project,
      Object.fromEntries(list.map((a) => [a.id, a])),
      dirs,
      parent,
    );
    const output = await new Deno.Command(uvBinary(), {
      args: [
        "run",
        "--frozen",
        "--project",
        cookerDir,
        "python",
        `${cookerDir}/check_clips.py`,
        `${result.dir}/scene.xml`,
        String(tolerance),
      ],
      stdout: "piped",
      stderr: "piped",
      env: { UV_PROJECT_ENVIRONMENT: `${dataDir}/cooker-venv` },
    }).output();
    if (!output.success) {
      const detail = new TextDecoder().decode(output.stderr).trim().split("\n").slice(-3).join(" ");
      return { clips: [], warnings: [`the clip check failed: ${detail}`] };
    }
    return JSON.parse(new TextDecoder().decode(output.stdout)) as ClipReport;
  } finally {
    await Deno.remove(parent, { recursive: true }).catch(() => {});
  }
}

// ── routes ──

const safeName = (name: string) => packageName(decodeURIComponent(name));

async function saveProject(unkeyed: Project) {
  const project = keyedProject(unkeyed);
  await Deno.mkdir(projectsDir, { recursive: true });
  await Deno.writeTextFile(
    `${projectsDir}/${packageName(project.name)}.json`,
    JSON.stringify(project, null, 2),
  );
}

// ── opening a world from anywhere: a project .json, an export's scene.json, or an export's folder ──

// a project opened from a file keeps saving to that file too: saved name -> its path
const linksFile = `${dataDir}/linked_files.json`;
const linkedFiles = () => readJson<Record<string, string>>(linksFile, {});

/** the editor's project inside some JSON: a project itself, or an export's scene.json (extensions.dim_world_builder) */
function projectIn(value: unknown): Project | null {
  const candidate = value as {
    format?: string;
    extensions?: Record<string, { project?: Project }>;
  } | null;
  if (candidate?.format === "dim-world-builder.project.v1") {
    return candidate as Project;
  }
  const project = candidate?.extensions?.dim_world_builder?.project;
  return project?.format === "dim-world-builder.project.v1" ? project : null;
}

/** read a world from a path; `linkable` is the file to keep saving into (a plain project file) */
async function projectFromPath(
  given: string,
): Promise<{ project: Project; linkable: string | null }> {
  let path = given.replace(/^~(?=$|\/)/, home);
  if ((await Deno.stat(path)).isDirectory) {
    const inside = [`${path}/scene.json`, `${path}/world.project.json`];
    const found = (await Promise.all(inside.map((f) => Deno.stat(f).then(() => f, () => null))))
      .find(Boolean);
    if (!found) {
      throw new Error(`${path} has no scene.json (not a World Builder export)`);
    }
    path = found;
  }
  const contents = JSON.parse(await Deno.readTextFile(path));
  const project = projectIn(contents);
  if (!project) {
    throw new Error(
      `${path} isn't a World Builder project or an export's scene.json`,
    );
  }
  // an export's scene.json is the export's, not the editor's: open a copy (export again to update it)
  return {
    project,
    linkable: project === contents ? await Deno.realPath(path) : null,
  };
}

/** save an opened world among the saved ones without clobbering a different saved world of the same name */
async function adopt(project: Project, source: string | null): Promise<string> {
  const links = await linkedFiles();
  const base = packageName(project.name);
  let name = base;
  let free = false;
  const same = JSON.stringify(keyedProject({ ...project, name: base }));
  for (let n = 2;; n++) {
    const saved = await readJson<Project | null>(
      `${projectsDir}/${name}.json`,
      null,
    );
    // free, this same file opened again, or a world identical to it (an export of a saved world): reuse the name
    free = !saved;
    if (
      !saved || (source && links[name] === source) ||
      JSON.stringify(keyedProject({ ...saved, name: base })) === same
    ) break;
    name = `${base}_${n}`;
  }
  project.name = name;
  await saveProject(project);
  if (source) links[name] = source;
  else if (free) delete links[name]; // a stale link of a deleted world
  await Deno.writeTextFile(linksFile, JSON.stringify(links, null, 2));
  return name;
}

/** show a saved world to the user: open World Builder at it (Desktop's window) and switch any page already open */
async function showWorld(name: string, focus: boolean) {
  const post = (path: string, body: unknown) =>
    fetch(`${desktopUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(async (r) => ({ ok: r.ok, status: r.status, text: await r.text() }))
      .catch((error) => ({ ok: false, status: 0, text: String(error) }));
  const appName = app.name ?? "dim-world-builder";
  await post(
    `/gateways/desktop/ui/apps/${encodeURIComponent(appName)}/frontend/open`,
    { name },
  );
  if (!focus) {
    return {
      shown: false,
      note: "show: false: only World Builder pages already open switch to it",
    };
  }
  const opened = await post(
    `/gateways/desktop/ui/apps/${encodeURIComponent(appName)}/open`,
    { path: `?open=${encodeURIComponent(name)}` },
  );
  return opened.ok ? { shown: true } : {
    shown: false,
    note: opened.status === 409 ? "no Desktop window is open" : opened.text.slice(0, 300),
  };
}

// ── the selection: the page that changed it last reports it; agents read it ──

let selection: { world: string | null; ids: string[]; items: Item[]; updatedAt: string | null } = {
  world: null,
  ids: [],
  items: [],
  updatedAt: null,
};

/** the selected items as the page has them (unsaved edits included), else as saved */
async function selectedItems() {
  const saved = selection.world
    ? await readJson<Project | null>(`${projectsDir}/${safeName(selection.world)}.json`, null)
    : null;
  return selection.ids.flatMap((id) => {
    const item = selection.items.find((i) => i.id === id) ?? saved?.items.find((i) => i.id === id);
    if (!item) return [];
    const { key, name, kind, floor, position, rotation, scale, params } = item;
    return [{ id, key, name, kind, floor, position, rotation, scale, params }];
  });
}

/** an image's type from its first bytes: JPEG or PNG only */
function imageType(bytes: Uint8Array): "jpg" | "png" | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if ([0x89, 0x50, 0x4e, 0x47].every((b, i) => bytes[i] === b)) return "png";
  return null;
}

/** what's wrong with an image item, if anything */
function imageProblem(item: Partial<Item>): string | null {
  if (item.kind !== "image") return null;
  const p = item.params as Partial<ImageParams> | undefined;
  if (typeof p?.src !== "string" || !p.src) {
    return "an image item needs params.src (POST api/images returns it)";
  }
  if (!(Number(p.width) > 0) || !(Number(p.height) > 0)) {
    return "an image item needs params.width and params.height in meters";
  }
  return null;
}

/** fill in what a caller may leave out of an item: an id, a name, the floor, a pose */
function completeItem(item: Partial<Item>, floor: string): Item {
  return {
    id: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
    name: item.name ?? item.kind ?? "item",
    floor: item.floor ?? floor,
    position: item.position ?? [0, 0, 0],
    rotation: item.rotation ?? [0, 0, 0, 1],
    scale: item.scale ?? [1, 1, 1],
    ...item,
  } as Item;
}

async function api(request: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const route = `${request.method} ${path}`;
  if (route === "GET /api/library") {
    return json((await assets()).list);
  }
  if (route === "GET /api/projects") {
    const names: string[] = [];
    try {
      for await (const entry of Deno.readDir(projectsDir)) {
        if (entry.name.endsWith(".json")) names.push(entry.name.replace(/\.json$/, ""));
      }
    } catch {
      // none yet
    }
    return json({ projects: names.sort() });
  }
  if (path.startsWith("/api/internal/projects/")) {
    const file = `${projectsDir}/${safeName(path.slice("/api/internal/projects/".length))}.json`;
    if (request.method === "GET") {
      const project = await readJson<Project | null>(file, null);
      return project ? json(project) : json({ error: "no such project" }, 404);
    }
    if (request.method === "PUT") {
      const text = JSON.stringify(await request.json(), null, 2);
      await Deno.mkdir(projectsDir, { recursive: true });
      await Deno.writeTextFile(file, text);
      const linked = (await linkedFiles())[
        safeName(path.slice("/api/internal/projects/".length))
      ];
      if (linked) await Deno.writeTextFile(linked, text);
      return json({ saved: file, ...(linked ? { alsoSaved: linked } : {}) });
    }
  }
  if (route === "POST /api/open") {
    const body = await request.json() as {
      name?: string;
      path?: string;
      project?: unknown;
      show?: boolean;
    };
    let name: string;
    let file: string | null = null;
    try {
      if (body.path) {
        const { project, linkable } = await projectFromPath(body.path);
        file = linkable;
        name = await adopt(project, linkable);
      } else if (body.project) {
        const project = projectIn(body.project);
        if (!project) {
          return json({
            error: "project isn't a World Builder project or an export's scene.json",
          }, 400);
        }
        name = await adopt(project, null);
      } else {
        name = safeName(body.name ?? "");
        await Deno.stat(`${projectsDir}/${name}.json`);
      }
    } catch (error) {
      return json({
        error: error instanceof Deno.errors.NotFound
          ? `not found: ${body.path ?? body.name}`
          : (error as Error).message ?? String(error),
      }, 404);
    }
    const project = await readJson<Project | null>(
      `${projectsDir}/${name}.json`,
      null,
    );
    return json({
      opened: name,
      items: project?.items.length ?? 0,
      ...(file ? { savesTo: file } : {}),
      ...await showWorld(name, body.show ?? true),
    });
  }
  if (route === "GET /api/project") {
    const project = await readJson<Project | null>(
      `${projectsDir}/${safeName(url.searchParams.get("name") ?? "")}.json`,
      null,
    );
    return project ? json(project) : json({ error: "no such project" }, 404);
  }
  if (route === "POST /api/project") {
    const { project } = await request.json() as { project: Project };
    if (project?.format !== "dim-world-builder.project.v1") {
      return json({ error: "expected { project } in dim-world-builder.project.v1 format" }, 400);
    }
    const problem = (project.items ?? []).map(imageProblem).find(Boolean);
    if (problem) return json({ error: problem }, 400);
    await saveProject(project);
    return json({ saved: packageName(project.name), items: project.items.length });
  }
  if (route === "POST /api/project/items") {
    // add items (each a partial item: kind, params, name, position, ...) to a saved project
    const { name, items } = await request.json() as { name: string; items: Partial<Item>[] };
    const file = `${projectsDir}/${safeName(name)}.json`;
    const project = await readJson<Project | null>(file, null);
    if (!project) return json({ error: `no project ${name}` }, 404);
    const problem = (items ?? []).map(imageProblem).find(Boolean);
    if (problem) return json({ error: problem }, 400);
    const added = (items ?? []).map((item) => completeItem(item, project.activeFloor));
    project.items.push(...added);
    await saveProject(project);
    const { warnings } = await clipCheck(project);
    return json({ added: added.map((i) => i.id), items: project.items.length, warnings });
  }
  if (route === "POST /api/generate") {
    const { kind, name, seed } = await request.json() as {
      kind: string;
      name?: string;
      seed?: number;
    };
    const library = (await assets()).list;
    const generators: Record<string, () => Project> = {
      playground: () => playground(library, seed ?? 7),
      test_course: () => testCourse(),
      clutter_yard: () => clutterYard(),
      empty: () => emptyProject(name ?? "untitled_world"),
    };
    const make = generators[kind];
    if (!make) {
      return json({ error: `kind must be one of ${Object.keys(generators).join(", ")}` }, 400);
    }
    const project = make();
    if (name) project.name = name;
    await saveProject(project);
    const { warnings } = await clipCheck(project);
    return json({ saved: packageName(project.name), items: project.items.length, warnings });
  }
  if (route === "POST /api/export") {
    const body = await request.json() as { project?: Project; name?: string; parentDir?: string };
    const project = body.project ??
      await readJson<Project | null>(`${projectsDir}/${safeName(body.name ?? "")}.json`, null);
    if (!project) return json({ error: "give { project } or the { name } of a saved one" }, 400);
    const parentDir = body.parentDir;
    const parent = (parentDir || `${home}/dimos_worlds`).replace(/^~(?=$|\/)/, home);
    const { list, dirs } = await assets();
    const result = await exportProject(
      project,
      Object.fromEntries(list.map((a) => [a.id, a])),
      dirs,
      parent,
    );
    await Deno.mkdir(projectsDir, { recursive: true });
    await Deno.writeTextFile(
      `${projectsDir}/${result.name}.json`,
      JSON.stringify(project, null, 2),
    );
    const { warnings } = await clipCheck(project);
    return json({ ...result, warnings });
  }
  if (route === "POST /api/check") {
    // a saved world by name, or a project as the page has it right now
    const body = await request.json() as { project?: Project; name?: string; tolerance?: number };
    const project = body.project ??
      await readJson<Project | null>(`${projectsDir}/${safeName(body.name ?? "")}.json`, null);
    if (!project) return json({ error: "give a saved world's { name } or a { project }" }, 400);
    return json(await clipCheck(project, body.tolerance ?? 0.02));
  }
  if (route === "GET /api/selection") {
    return json({
      world: selection.world ? safeName(selection.world) : null,
      items: await selectedItems(),
      updatedAt: selection.updatedAt,
    });
  }
  if (route === "POST /api/internal/selection") {
    const body = await request.json() as { world?: string; ids?: string[]; items?: Item[] };
    selection = {
      world: body.world || null,
      ids: Array.isArray(body.ids) ? body.ids.map(String) : [],
      items: Array.isArray(body.items) ? body.items : [],
      updatedAt: new Date().toISOString(),
    };
    return json({ selected: selection.ids.length });
  }
  if (route === "POST /api/images") {
    const bytes = new Uint8Array(await request.arrayBuffer());
    const extension = imageType(bytes);
    if (!extension) return json({ error: "the body must be a JPEG or PNG image" }, 415);
    const name = url.searchParams.get("name") || "image";
    const id = `${packageName(name).slice(0, 24)}_${crypto.randomUUID().slice(0, 6)}`;
    await Deno.mkdir(imagesDir, { recursive: true });
    await Deno.writeFile(`${imagesDir}/${id}.${extension}`, bytes);
    return json({ id, src: `files/images/${id}.${extension}` });
  }
  if (route === "GET /api/views") {
    const project = await readJson<Project | null>(
      `${projectsDir}/${safeName(url.searchParams.get("name") ?? "")}.json`,
      null,
    );
    return project
      ? json({ views: keyedProject(project).views ?? [] })
      : json({ error: "no such project" }, 404);
  }
  if (route === "POST /api/views") {
    // remember a view (by name; its key comes from the name) in a saved world, replacing one with the same key
    const { name, view } = await request.json() as {
      name: string;
      view: { name: string; eye: Vec3; target: Vec3; fov?: number; key?: string };
    };
    const file = `${projectsDir}/${safeName(name ?? "")}.json`;
    const project = await readJson<Project | null>(file, null);
    if (!project) return json({ error: `no project ${name}` }, 404);
    if (!view?.name || !Array.isArray(view.eye) || !Array.isArray(view.target)) {
      return json(
        { error: "give { name, view: { name, eye: [x,y,z], target: [x,y,z], fov? } }" },
        400,
      );
    }
    const key = view.key || slug(view.name).replace(/^item_/, "view_");
    const saved = { key, name: view.name, eye: view.eye, target: view.target, fov: view.fov ?? 50 };
    project.views = [...(project.views ?? []).filter((v) => v.key !== key), saved];
    await saveProject(project);
    return json({ saved: key, views: project.views.length });
  }
  if (route === "POST /api/views/remove") {
    const { name, view } = await request.json() as { name: string; view: string };
    const file = `${projectsDir}/${safeName(name ?? "")}.json`;
    const project = await readJson<Project | null>(file, null);
    if (!project) return json({ error: `no project ${name}` }, 404);
    const before = project.views?.length ?? 0;
    project.views = (project.views ?? []).filter((v) => v.key !== view);
    await saveProject(project);
    return json({ removed: before - project.views.length });
  }
  if (route === "GET /api/views/image") {
    // the world as exported, seen from a remembered view: MuJoCo renders it (the same cameras the sim has)
    const name = url.searchParams.get("name") ?? "";
    const key = url.searchParams.get("view") ?? "";
    const project = await readJson<Project | null>(`${projectsDir}/${safeName(name)}.json`, null);
    if (!project) return json({ error: `no project ${name}` }, 404);
    if (!(keyedProject(project).views ?? []).some((v) => v.key === key)) {
      return json({ error: `no view ${key} (GET api/views lists them)` }, 404);
    }
    const size = (param: string, fallback: number) =>
      Math.max(16, Math.min(1920, Number(url.searchParams.get(param)) || fallback));
    const parent = `${dataDir}/renders`;
    const { list, dirs } = await assets();
    const result = await exportProject(
      project,
      Object.fromEntries(list.map((a) => [a.id, a])),
      dirs,
      parent,
    );
    const out = `${parent}/${result.name}_${key}.png`;
    const output = await new Deno.Command(uvBinary(), {
      args: [
        "run",
        "--frozen",
        "--project",
        cookerDir,
        "python",
        `${cookerDir}/render_view.py`,
        `${result.dir}/scene.xml`,
        key,
        String(size("width", 960)),
        String(size("height", 540)),
        out,
      ],
      stdout: "piped",
      stderr: "piped",
      env: { UV_PROJECT_ENVIRONMENT: `${dataDir}/cooker-venv` },
    }).output();
    if (!output.success) {
      return json({
        error: "render failed",
        detail: new TextDecoder().decode(output.stderr).slice(-2000),
      }, 500);
    }
    return new Response(await Deno.readFile(out), { headers: { "content-type": "image/png" } });
  }
  if (route === "POST /api/internal/visual") {
    const dir = url.searchParams.get("dir") ?? "";
    await Deno.stat(`${dir}/scene.xml`); // only into a folder this app exported
    await Deno.writeFile(`${dir}/visual.glb`, new Uint8Array(await request.arrayBuffer()));
    return json({ written: `${dir}/visual.glb` });
  }
  if (route === "GET /api/internal/dirs") {
    const requested = (url.searchParams.get("path") || home).replace(
      /^~(?=$|\/)/,
      home,
    );
    const dirs: string[] = [];
    const files: string[] = [];
    try {
      for await (const entry of Deno.readDir(requested)) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory) dirs.push(entry.name);
        else if (entry.name.endsWith(".json")) files.push(entry.name);
      }
    } catch (error) {
      return json({
        path: requested,
        error: String(error),
        dirs: [],
        files: [],
      });
    }
    // exported worlds: folders with a scene.json, which open like a file
    const worlds = (await Promise.all(
      dirs.map((d) => Deno.stat(`${requested}/${d}/scene.json`).then(() => d, () => null)),
    )).filter((d): d is string => !!d).sort();
    const parent = requested.replace(/\/[^/]+\/?$/, "") || "/";
    return json({
      path: requested,
      parent,
      home,
      dirs: dirs.sort(),
      files: files.sort(),
      worlds,
    });
  }
  if (route === "POST /api/internal/save-as") {
    const body = await request.json() as { project?: unknown; path?: string };
    const project = projectIn(body.project);
    if (!project || !body.path) return json({ error: "give { project, path }" }, 400);
    let path = body.path.replace(/^~(?=$|\/)/, home);
    if (await Deno.stat(path).then((s) => s.isDirectory, () => false)) {
      path = `${path.replace(/\/$/, "")}/${packageName(project.name)}.json`;
    }
    if (!path.endsWith(".json")) path += ".json";
    // never write over a file that isn't a world
    const existing = await readJson<unknown>(path, undefined);
    const occupied = await Deno.stat(path).then(() => true, () => false);
    if (occupied && !projectIn(existing)) {
      return json({ error: `${path} exists and isn't a World Builder project` }, 409);
    }
    try {
      await Deno.writeTextFile(path, JSON.stringify(project, null, 2));
    } catch (error) {
      return json({ error: (error as Error).message }, 400);
    }
    await saveProject(project);
    const links = await linkedFiles();
    links[packageName(project.name)] = await Deno.realPath(path);
    await Deno.writeTextFile(linksFile, JSON.stringify(links, null, 2));
    return json({ saved: links[packageName(project.name)] });
  }
  if (route === "GET /api/internal/linked") {
    return json(await linkedFiles());
  }
  if (route === "POST /api/internal/import") {
    const name = url.searchParams.get("name") || "imported";
    const extension = (url.searchParams.get("ext") || "glb").replace(/[^a-z]/g, "");
    const height = Number(url.searchParams.get("height")) || null;
    const id = `${packageName(name).slice(0, 24)}_${crypto.randomUUID().slice(0, 6)}`;
    await Deno.mkdir(`${dataDir}/uploads`, { recursive: true });
    const input = `${dataDir}/uploads/${id}.${extension}`;
    await Deno.writeFile(input, new Uint8Array(await request.arrayBuffer()));
    const job: CookJob = { id, name, state: "running", stage: "starting", progress: 0, log: [] };
    jobs.set(id, job);
    cook(job, input, height).catch((error) => {
      job.state = "failed";
      job.stage = String(error);
    });
    return json({ job: id });
  }
  if (request.method === "GET" && path.startsWith("/api/internal/import/")) {
    const job = jobs.get(path.slice("/api/internal/import/".length));
    return job ? json({ ...job, log: job.log.slice(-12) }) : json({ error: "no such job" }, 404);
  }
  return path.startsWith("/api/") ? json({ error: `no ${route}` }, 404) : null;
}

// ── files: the page (vite's build) and mesh assets ──

const types: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript",
  css: "text/css",
  svg: "image/svg+xml",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  glb: "model/gltf-binary",
  obj: "text/plain",
  woff2: "font/woff2",
};

async function file(dir: string, path: string): Promise<Response> {
  const clean = path.split("/").filter((part) => part && part !== "..").join("/") || "index.html";
  try {
    const handle = await Deno.open(`${dir}/${clean}`);
    return new Response(handle.readable, {
      headers: {
        "content-type": types[clean.split(".").pop() ?? ""] ?? "application/octet-stream",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

async function serve(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  try {
    const answer = await api(request, url);
    if (answer) return answer;
    if (path.startsWith("/files/library/")) {
      return await file(libraryDir, path.slice("/files/library/".length));
    }
    if (path.startsWith("/files/imports/")) {
      return await file(importsDir, path.slice("/files/imports/".length));
    }
    if (path.startsWith("/files/images/")) {
      return await file(imagesDir, path.slice("/files/images/".length));
    }
    if (path.startsWith("/files/apriltags/")) {
      return await file(`${root}/assets/apriltags`, path.slice("/files/apriltags/".length));
    }
    if (path.startsWith("/files/robots/")) {
      return await file(`${root}/assets/robots`, path.slice("/files/robots/".length));
    }
    return await file(frontend, path);
  } catch (error) {
    return json({ error: String(error) }, 500);
  }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  Deno.addSignalListener(signal, () => Deno.exit(0));
}

if (app.socket) {
  try {
    Deno.removeSync(app.socket);
  } catch {
    // not there
  }
  Deno.serve({
    path: app.socket,
    transport: "unix",
    onListen: () => console.error(`listening on ${app.socket}`),
  }, serve);
} else {
  // outside Desktop: `deno task serve` serves on a port (http://localhost:8787/)
  Deno.serve({ port: Number(flag("port") ?? 8787) }, serve);
}

export { desktopUrl };

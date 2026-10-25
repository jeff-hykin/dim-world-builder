// Writes a project as a directory dimos can load: `--scene-package <dir>` for sim2, `import <name>.world` for Python (a namespace package: no __init__.py).
//   <dir>/scene.xml  scene.json  world.py  blueprints.py  scene_data.py  pyproject.toml  README.md  meshes/<asset>/*  textures/  [visual.glb]

import { buildWorld } from "../src/world/geometry.ts";
import { toScene } from "../src/world/mjcf.ts";
import { keyedProject, packageName } from "../src/world/keys.ts";
import { exportAnnotations, withAnnotations } from "../src/world/annotations.ts";
import type { MeshAsset, Project } from "../src/world/types.ts";

/** scene.json extensions key for this app's data (views, project) */
export const EXTENSION = "dim_world_builder";

export { packageName };

export interface ExportResult {
  dir: string;
  name: string;
  files: string[];
  bodies: number;
  movers: number;
}

export async function exportProject(
  unkeyed: Project,
  assets: Record<string, MeshAsset>,
  /** asset id -> the folder holding its files on this machine */
  assetDirs: Record<string, string>,
  parentDir: string,
  options: { visualGlb?: Uint8Array } = {},
): Promise<ExportResult> {
  const assetsRoot = new URL("../assets", import.meta.url).pathname;
  // every item exports under its readable id ("bed_2")
  const project = withAnnotations(keyedProject(unkeyed));
  const name = packageName(project.name);
  const dir = `${parentDir.replace(/\/+$/, "")}/${name}`;
  const built = buildWorld(project, assets);
  // image items are reference photos for the editor: no body, no geom, no mover in the sim (nor the clip check)
  const images = new Set(built.bodies.filter((b) => b.kind === "image").map((b) => b.name));
  const world = {
    ...built,
    bodies: built.bodies.filter((b) => !images.has(b.name)),
    movers: built.movers.filter((m) => !images.has(m.body)),
  };
  const scene = toScene(world, name);
  await Deno.mkdir(`${dir}/meshes`, { recursive: true });
  const files: string[] = [];
  const write = async (path: string, text: string) => {
    await Deno.writeTextFile(`${dir}/${path}`, text);
    files.push(path);
  };
  await write("scene.xml", scene.xml);
  // sim2's scene, plus (in extensions, which sim2 ignores) the views and the editor's project
  const sceneJson = {
    ...(scene.sceneJson as Record<string, unknown>),
    annotations: exportAnnotations(project),
    extensions: {
      [EXTENSION]: { views: (scene.viewsJson as { views: unknown[] }).views, project },
    },
  };
  await write("scene.json", JSON.stringify(sceneJson, null, 2) + "\n");
  // earlier exports' files, now folded into scene.json (and dimos allows no __init__.py)
  const stale = [
    "movers.json",
    "views.json",
    "world.project.json",
    "nav_eval.json",
    "world.json",
    "__init__.py",
    "__main__.py",
  ];
  for (const file of stale) await Deno.remove(`${dir}/${file}`).catch(() => {});
  // a namespace package: the world, its blueprints, the SceneData module
  await write("world.py", worldModule(name, project));
  await write("blueprints.py", blueprintsModule(name));
  await write("README.md", readme(name, project));
  await write("pyproject.toml", pyproject(name));
  // the SceneData module (scene_data_request -> scene_data), the same file in every export
  await write(
    "scene_data.py",
    await Deno.readTextFile(new URL("./python/scene_data.py", import.meta.url)),
  );
  for (const [asset, meshFiles] of scene.meshFiles) {
    const source = assetDirs[asset];
    if (!source) throw new Error(`no files for mesh asset ${asset}`);
    await Deno.mkdir(`${dir}/meshes/${asset}`, { recursive: true });
    for (const file of meshFiles) {
      await copyWritable(`${source}/${file}`, `${dir}/meshes/${asset}/${file}`);
      files.push(`meshes/${asset}/${file}`);
    }
  }
  if (scene.textureFiles.size) await Deno.mkdir(`${dir}/textures`, { recursive: true });
  for (const texture of scene.textureFiles) {
    const name = texture.split("/").pop()!;
    await copyWritable(`${assetsRoot}/${texture}`, `${dir}/textures/${name}`);
    files.push(`textures/${name}`);
  }
  if (options.visualGlb) {
    await Deno.writeFile(`${dir}/visual.glb`, options.visualGlb);
    files.push("visual.glb");
  }
  return { dir, name, files, bodies: world.bodies.length, movers: world.movers.length };
}

function readme(name: string, project: Project): string {
  const world = name.replace(/_/g, "-");
  return `# ${name}

A [dim-world-builder](https://github.com/jeff-hykin/dim-world-builder) world: ${project.items.length} items,
${project.floors.length} floor(s). \`scene.json\` is sim2's scene; its \`extensions.${EXTENSION}\` holds the views and the editor's
project; its \`annotations\` are labeled points, paths and areas (the nav test: \`verify/nav_eval.py\` runs it).

\`\`\`sh
uv pip install -e .                                          # into dimos's venv
dtk run ${world}.go2 --simulation mujoco --transport zenoh   # a Go2 here, plus SceneData
python -m ${name}.world                                      # compile and summarize
\`\`\`

\`\`\`python
from ${name} import world
world.render_view("overview")   # RGB image from a saved view
\`\`\`
`;
}

function worldModule(name: string, project: Project): string {
  return `"""${name}: a dim-world-builder world for dimos sim2 (MuJoCo); \`python -m ${name}.world\` checks it.

Files beside this one: scene.xml (MJCF), scene.json (dimos.scene.v1: entities, spawns, movers; its extensions.${EXTENSION}
holds the remembered camera views and the editor's project; annotations: labeled points, paths, areas), meshes/, textures/, scene_data.py (the SceneData module) and
blueprints.py (\`go2\`).
${project.items.length} items, ${project.floors.length} floor(s).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import mujoco
import numpy as np
from numpy.typing import NDArray

SCENE_DIR = Path(__file__).resolve().parent
SCENE_XML = SCENE_DIR / "scene.xml"
SCENE_JSON = SCENE_DIR / "scene.json"

_scene = json.loads(SCENE_JSON.read_text())
_world = _scene.get("extensions", {}).get("${EXTENSION}", {})
SPAWNS: dict[str, dict[str, Any]] = _scene.get("spawns", {})
ENTITIES: dict[str, dict[str, Any]] = _scene.get("entities", {})
MOVERS: list[dict[str, Any]] = _scene.get("movers", [])
# remembered camera views: each is a fixed <camera> in scene.xml named by its "camera" id
VIEWS: list[dict[str, Any]] = _world.get("views", [])
# labeled points, paths and areas (the nav test: a path tagged nav:mapping, points tagged nav:goal)
ANNOTATIONS: list[dict[str, Any]] = _scene.get("annotations", [])


def annotations(tag: str) -> list[dict[str, Any]]:
    """The annotations carrying \`tag\`, e.g. annotations("nav:goal")."""
    return [a for a in ANNOTATIONS if tag in a.get("tags", [])]


def check() -> mujoco.MjModel:
    """Compile scene.xml with MuJoCo."""
    return mujoco.MjModel.from_xml_path(str(SCENE_XML))


def render_view(
    name: str,
    width: int = 640,
    height: int = 480,
    model: mujoco.MjModel | None = None,
    data: mujoco.MjData | None = None,
) -> NDArray[np.uint8]:
    """An RGB image (height x width x 3) from the remembered view \`name\` (see VIEWS).

    Without \`model\`/\`data\` it renders this world as exported; pass a running simulation's MjModel and MjData (whose
    scene includes this world's cameras) to see the live state, e.g. to check whether a task was done.
    """
    if model is None:
        model = check()
    if data is None:
        data = mujoco.MjData(model)
        mujoco.mj_forward(model, data)
    camera = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_CAMERA, name)
    if camera < 0:
        known = [view["camera"] for view in VIEWS]
        raise KeyError(f"no camera {name!r} in the model (this world's views: {known})")
    width = min(width, int(model.vis.global_.offwidth))
    height = min(height, int(model.vis.global_.offheight))
    renderer = mujoco.Renderer(model, height, width)
    try:
        renderer.update_scene(data, camera=camera)
        image: NDArray[np.uint8] = renderer.render()
        return image
    finally:
        renderer.close()


def main() -> None:
    model = check()
    print(
        f"{SCENE_XML}: {model.nbody} bodies, {model.ngeom} geoms, {len(MOVERS)} movers, spawns {sorted(SPAWNS)}, "
        f"views {[view['camera'] for view in VIEWS]}"
    )


if __name__ == "__main__":
    main()
`;
}

function blueprintsModule(name: string): string {
  return `"""Runnable blueprints for this world (the pyproject's dimos.blueprints entry points): \`dimos run ${
    name.replace(/_/g, "-")
  }.go2\`."""

from __future__ import annotations

from ${name}.scene_data import SceneData
from ${name}.world import SCENE_DIR

from dimos.core.coordination.blueprints import Blueprint, autoconnect
from dimos.core.global_config import global_config
from dimos.robot.get_all_blueprints import get_blueprint_by_name


def with_robot(robot: str) -> Blueprint:
    """\`robot\` (any sim2 blueprint that honors scene_package) in this world, plus the SceneData module."""
    global_config.update(simulation="mujoco", scene_package=str(SCENE_DIR))
    return autoconnect(get_blueprint_by_name(robot), SceneData.blueprint())


go2 = with_robot("unitree-go2-freewalk")
`;
}

/** a copy the next export can overwrite: sources in the Nix store are read-only, and a copy keeps that mode */
async function copyWritable(from: string, to: string) {
  await Deno.remove(to).catch(() => {});
  await Deno.copyFile(from, to);
  await Deno.chmod(to, 0o644);
}

/** makes the folder a pip package that registers dimos blueprints: \`dimos run <name>.go2\` and \`<name>.scene-data\` */
function pyproject(name: string): string {
  return `# pip install -e this folder (into dimos's venv) and dimos finds its blueprints:
#   dimos run ${name.replace(/_/g, "-")}.go2          a Go2 in this world, plus the SceneData module
#   dimos run <blueprint> ${
    name.replace(/_/g, "-")
  }.scene-data --scene-package <this folder>   SceneData beside any sim2 blueprint
[project]
name = "${name}"
version = "0.1.0"
description = "A dim-world-builder world for dimos sim2"
requires-python = ">=3.10"

[project.entry-points."dimos.blueprints"]
go2 = "${name}.blueprints:go2"
scene-data = "${name}.scene_data:SceneData"

[build-system]
requires = ["setuptools>=64"]
build-backend = "setuptools.build_meta"

[tool.setuptools]
packages = ["${name}"]
package-dir = { "${name}" = "." }

[tool.setuptools.package-data]
"*" = ["*", "**/*"]
`;
}

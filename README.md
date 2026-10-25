# World Builder

Build 3D worlds for dimos's MuJoCo sim (sim2), export them, drop a robot in.

## How to install

```sh
# 1. dimOS Desktop (Mac or Linux)
curl -fsSL https://raw.githubusercontent.com/jeff-hykin/dimos-desktop-mirror/main/install.sh | bash
# 2. World Builder, as a Desktop app
dimos-desktop install github.com/jeff-hykin/dim-world-builder --ref main
```

![tour](https://github.com/jeff-hykin/dim-world-builder/releases/download/v0.1.0/0_playground_tour.gif)

## Use an export in dimos

```sh
uv pip install -e ~/dimos_worlds/<world>                                  # into dimos's venv
dimos run <world>.go2 --simulation mujoco --transport zenoh               # a Go2 in it + SceneData
dimos run <blueprint> <world>.scene-data --scene-package ~/dimos_worlds/<world>   # SceneData beside any sim2 blueprint
```

Export: `scene.xml`, `scene.json` (sim2: movers; `annotations`: labeled points, paths, areas, e.g.
the nav test; views + project in `extensions`), `world.py` / `blueprints.py` / `scene_data.py` (a
namespace package), `meshes/`, `textures/`. Python:
`from <world> import world; world.render_view("overview")`. `SceneData` answers
`/scene_data_request` on `/scene_data` (meshes, lights, cameras) and announces itself on
`/scene_info`; the [Controller](https://github.com/jeff-hykin/dim-controller) draws it as the
"Simulated world" layer. Needs dimos branch `jeff/feat/sim2_world_builder`.

## Nav test

```sh
python verify/nav_eval.py ~/dimos_worlds/<world> --blueprint unitree-go2-freewalk   # walks the nav:mapping path, then nav:goal points
python verify/drive_go2.py examples/nav_test_course                                 # walls, crates, cart, stairs collide
```

![nav test](https://github.com/jeff-hykin/dim-world-builder/releases/download/v0.1.0/10_nav_test.gif)
![viewer](https://github.com/jeff-hykin/dim-world-builder/releases/download/v0.1.0/9_viewer_mode.gif)

## Editing

|                                                                                                                                                            |                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Import a GLB (cooked into convex hulls) ![](https://github.com/jeff-hykin/dim-world-builder/releases/download/v0.1.0/1_import_and_cook.gif)                | Move / rotate / scale ![](https://github.com/jeff-hykin/dim-world-builder/releases/download/v0.1.0/2_add_move_rotate_scale.gif)            |
| Stairs: straight, switchback, spiral, open risers, railings ![](https://github.com/jeff-hykin/dim-world-builder/releases/download/v0.1.0/3_stairs.gif)     | Bumpy hills ![](https://github.com/jeff-hykin/dim-world-builder/releases/download/v0.1.0/4_hills.gif)                                      |
| 80 assets + clutter ![](https://github.com/jeff-hykin/dim-world-builder/releases/download/v0.1.0/5_asset_palette.gif)                                      | Floors ![](https://github.com/jeff-hykin/dim-world-builder/releases/download/v0.1.0/6_floors.gif)                                          |
| Rooms, doors, windows, ceilings ![](https://github.com/jeff-hykin/dim-world-builder/releases/download/v0.1.0/7_rooms.gif)                                  | Moving obstacles ![](https://github.com/jeff-hykin/dim-world-builder/releases/download/v0.1.0/8_moving_objects.gif)                        |
| Holes + AprilTags ![](https://github.com/jeff-hykin/dim-world-builder/releases/download/v0.1.0/11_holes_and_apriltags.gif)                                 | Drain grates, lights, saved views ![](https://github.com/jeff-hykin/dim-world-builder/releases/download/v0.1.0/12_grates_lights_views.gif) |
| The 555 office, rebuilt from lidar maps; walking people ![](https://github.com/jeff-hykin/dim-world-builder/releases/download/v0.1.0/13_office_people.gif) |                                                                                                                                            |

Agents: every action is an endpoint (`dimos.yaml`); `deno run -A tools/dwb.ts --help` is the CLI.
`dwb check` reports clipping (edits, generate and export return the same warnings). Example built
that way: [tools/examples/office_555.ts](tools/examples/office_555.ts).

Reference photos: `POST api/images` (a JPEG/PNG body) returns `{ id, src }`; an item of kind `image`
(`params: { src, width, height, opacity?, doubleSided? }`) shows it on a plane in the item's local
y-z, centered on its position, facing +x. It is visual only: no collision, not in the clip check,
left out of the export. `GET api/selection` is what the user has selected in the page used last.

Working on a world with an agent: changes made through the API (`POST`/`PATCH`/`DELETE
api/project/items`, `POST api/project`, `POST api/project/undo`, ...) show up live in the open pages,
keeping their view and selection; a page with unsaved edits keeps them and asks before loading the
new version. `GET|POST api/camera` reads or moves the user's view, `POST api/highlight` blinks items,
`GET api/project/history` lists a world's last 50 versions. Items can carry `notes`.

## Develop

```sh
deno run -A backend/main.ts --port 8797 & API_PORT=8797 deno task dev
deno task test && deno task check && dimos-desktop app check .
deno task update-hashes   # after changing deno.json or deno.lock: flake.nix's hashes for the page
```

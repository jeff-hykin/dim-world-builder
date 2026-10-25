// The side panels: Add (the palette), Floors, Items, and the Inspector for the selected item.

import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import {
  Badge,
  Button,
  ButtonGroup,
  Field,
  Icon,
  IconButton,
  List,
  ListRow,
  NumberInput,
  SearchInput,
  Segmented,
  Slider,
  Text,
  TextInput,
  Tile,
  TileGrid,
  Toggle,
} from "../ui.ts";
import { defaultGrate, PAINT } from "../world/defaults.ts";
import { openingPreset } from "../world/geometry.ts";
import { climbing, coveringSlab, floorAbove, openingAbove } from "../world/stairs_fit.ts";
import { NAV_GOAL, NAV_MAPPING } from "../world/annotations.ts";
import { slug } from "../world/keys.ts";
import type {
  Annotation,
  AprilTagParams,
  CameraView,
  DoorOpening,
  Floor,
  FloorFinish,
  GrateParams,
  HillParams,
  HoleParams,
  ImageParams,
  Item,
  ItemGroup,
  LightParams,
  MeshAsset,
  OpeningKind,
  Quat,
  Rgb,
  RoomParams,
  StairsParams,
  Vec3,
} from "../world/types.ts";
import { assetEntries, BUILT_IN, type PaletteEntry, view } from "./palette.ts";
import {
  addFloor,
  addItem,
  addItems,
  duplicateItem,
  getState,
  removeFloor,
  removeItem,
  removeLabel,
  removeView,
  renameKey,
  renameView,
  saveView,
  select,
  selectLabel,
  setActiveFloor,
  setDrawingPath,
  setLabelTarget,
  setMover,
  setNavTool,
  updateFloor,
  updateItem,
  updateLabel,
  updateView,
  useEditor,
} from "./store.ts";

const section: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: 12,
};
const heading: React.CSSProperties = {
  fontSize: 11,
  textTransform: "var(--label-case)" as React.CSSProperties["textTransform"],
  letterSpacing: "var(--track-label)",
  color: "var(--muted-fg)",
  margin: "6px 0 0",
};

// ── Add ──

/** adds a palette entry's item(s) where the view is centered, on the floor being edited */
function addEntry(entry: PaletteEntry) {
  if (entry.tool) {
    setNavTool(entry.tool);
    return;
  }
  const { floors, activeFloor: floor } = getState().project;
  // on whatever the view is centered on: the floor, or the desk standing there
  const at: Vec3 = [view.center[0], view.center[1], view.surfaceAt(view.center[0], view.center[1])];
  if (entry.makeMany) return addItems(entry.makeMany(floor, at));
  const item = entry.make(floor, at);
  // stairs added under another floor climb all the way to it
  const above = item.kind === "stairs" ? floorAbove(floors, floor) : undefined;
  const here = floors.find((f) => f.id === floor);
  if (item.kind === "stairs" && above && here) {
    item.params = climbing(item.params, above.elevation - here.elevation);
  }
  addItem(item);
}

/** palette tiles, one heading per group, filtered by a search box when `search` */
function Palette({ entries, search, children }: {
  entries: PaletteEntry[];
  search?: boolean;
  children?: React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  const shown = entries.filter((e) => e.title.toLowerCase().includes(query.toLowerCase()));
  const groups = [...new Set(shown.map((e) => e.group))];
  return (
    <>
      {search && <SearchInput value={query} onChange={setQuery} placeholder="Search" />}
      {children}
      {groups.map((group) => (
        <div key={group}>
          <p style={heading}>{group}</p>
          <TileGrid min={78}>
            {shown.filter((e) => e.group === group).map((entry) => (
              <Tile
                key={entry.key}
                title={entry.title}
                data-testid={`add-${entry.key}`}
                icon={entry.thumb ? undefined : entry.icon}
                media={entry.thumb
                  ? (
                    <img
                      src={entry.thumb}
                      alt=""
                      style={{ width: 52, height: 52, objectFit: "contain" }}
                    />
                  )
                  : undefined}
                onClick={() => addEntry(entry)}
              />
            ))}
          </TileGrid>
        </div>
      ))}
      {shown.length === 0 && <Text small muted>Nothing matches “{query}”.</Text>}
    </>
  );
}

const SHAPE_GROUPS = new Set(["Shapes", "Clutter"]);

/** geometric solids and simple procedural things: sized freely */
export function ShapesPanel() {
  return (
    <div style={section} data-testid="shapes-panel">
      <Palette entries={BUILT_IN.filter((e) => SHAPE_GROUPS.has(e.group))} />
    </div>
  );
}

/** the modeled library (by category) and imported models */
export function LibraryPanel({ assets, onImport }: { assets: MeshAsset[]; onImport: () => void }) {
  const entries = useMemo(() => assetEntries(assets), [assets]);
  return (
    <div style={section} data-testid="add-panel">
      <Palette entries={entries} search>
        <Button icon="upload" onClick={onImport} data-testid="import-open">Import a GLB…</Button>
      </Palette>
    </div>
  );
}

/** what gives a world its structure: floors, then rooms, stairs, holes, hills, lights, tags */
export function BuildersPanel() {
  return (
    <div style={section} data-testid="builders-panel">
      <FloorsPanel />
      <Palette entries={BUILT_IN.filter((e) => !SHAPE_GROUPS.has(e.group))} />
      <Text small muted>
        Moving obstacles: select any item, then Motion → Make it a moving object, and click out its
        path.
      </Text>
    </div>
  );
}

// ── Floors ──

export function FloorsPanel() {
  const floors = useEditor((s) => s.project.floors);
  const active = useEditor((s) => s.project.activeFloor);
  const items = useEditor((s) => s.project.items);
  const sorted = [...floors].sort((a, b) => b.elevation - a.elevation);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="floors-panel">
      <p style={heading}>Floors</p>
      <Text small muted>
        New items go on the selected floor, the only one you can pick from; floors above it are
        drawn see-through.
      </Text>
      <List divided>
        {sorted.map((floor) => (
          <ListRow
            key={floor.id}
            icon="layers"
            data-testid={`floor-${floor.id}`}
            title={floor.name}
            subtitle={`${floor.elevation.toFixed(2)} m · ${
              items.filter((i) => i.floor === floor.id).length
            } items`}
            selected={floor.id === active}
            onClick={() =>
              setActiveFloor(floor.id)}
            actions={floors.length > 1
              ? (
                <IconButton
                  icon="trash"
                  label={`Remove ${floor.name}`}
                  size="sm"
                  variant="ghost"
                  onClick={(e: React.MouseEvent) => {
                    e.stopPropagation();
                    removeFloor(floor.id);
                  }}
                />
              )
              : undefined}
          />
        ))}
      </List>
      <Button
        icon="plus"
        onClick={() =>
          addFloor(view.center)}
        data-testid="add-floor"
      >
        Add a floor above
      </Button>
      {floors.filter((f) => f.id === active).map((floor) => (
        <div key={floor.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={heading}>Selected floor</p>
          <FloorEditor floor={floor} />
        </div>
      ))}
    </div>
  );
}

/** a floor's settings: name, height, slab (finish, color, thickness, size, center); in the Floors panel and, when a
 * floor is picked and nothing is selected, in the inspector */
export function FloorEditor({ floor }: { floor: Floor }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="floor-editor">
      <Field label="Name">
        <TextInput
          value={floor.name}
          onChange={(name: string) =>
            updateFloor(floor.id, { name })}
        />
      </Field>
      <Field label="Height above the ground (its items move with it)">
        <NumberInput
          value={floor.elevation}
          step={0.1}
          precision={2}
          unit="m"
          data-testid="floor-elevation"
          onChange={(elevation: number) =>
            updateFloor(floor.id, { elevation })}
        />
      </Field>
      <Toggle
        value={Boolean(floor.slab)}
        onChange={(on: boolean) =>
          updateFloor(floor.id, {
            slab: on
              ? {
                thickness: floor.elevation > 0 ? 0.2 : 0.3,
                sizeX: 10,
                sizeY: 10,
                center: [Math.round(view.center[0]), Math.round(view.center[1])],
              }
              : undefined,
          })}
        label="Solid slab (what its items stand on; holes cut into it)"
      />
      {!floor.slab && (
        <Text small muted data-testid="no-slab-note">
          FYI: the floor will be an invisible plane for placing objects (outlined in the editor, not
          in the exported scene).
        </Text>
      )}
      {floor.slab && (
        <>
          <Field label="Floor finish">
            <Segmented
              size="sm"
              value={floor.slab.finish ?? "plain"}
              items={[
                { value: "plain", label: "Plain" },
                { value: "concrete", label: "Concrete" },
                { value: "wood", label: "Wood" },
                { value: "tile", label: "Tile" },
                { value: "carpet", label: "Carpet" },
              ]}
              data-testid="floor-finish"
              onChange={(finish: string) =>
                updateFloor(floor.id, {
                  slab: { ...floor.slab!, finish: finish as FloorFinish },
                })}
            />
          </Field>
          <Field label="Floor color">
            <Swatches
              value={floor.slab.color ?? [0.26, 0.27, 0.29]}
              onChange={(color) => updateFloor(floor.id, { slab: { ...floor.slab!, color } })}
            />
          </Field>
          <Range
            label="Slab thickness"
            value={floor.slab.thickness}
            min={0.05}
            max={5}
            step={0.05}
            unit="m"
            onChange={(thickness) => updateFloor(floor.id, { slab: { ...floor.slab!, thickness } })}
          />
          <Field label="Slab size (m)">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              {(["sizeX", "sizeY"] as const).map((key) => (
                <NumberInput
                  key={key}
                  size="sm"
                  value={floor.slab![key]}
                  step={0.5}
                  precision={1}
                  unit={key === "sizeX" ? "x" : "y"}
                  aria-label={`Slab size ${key === "sizeX" ? "x" : "y"} (m)`}
                  onChange={(v: number) =>
                    updateFloor(floor.id, {
                      slab: { ...floor.slab!, [key]: Math.max(0.5, v) },
                    })}
                />
              ))}
            </div>
          </Field>
          <Field label="Slab center (m)">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              {[0, 1].map((axis) => (
                <NumberInput
                  key={axis}
                  size="sm"
                  value={floor.slab!.center[axis]}
                  step={0.5}
                  precision={1}
                  unit={axis ? "y" : "x"}
                  aria-label={`Slab center ${axis ? "y" : "x"} (m)`}
                  onChange={(v: number) => {
                    const center = [...floor.slab!.center] as [number, number];
                    center[axis] = v;
                    updateFloor(floor.id, { slab: { ...floor.slab!, center } });
                  }}
                />
              ))}
            </div>
          </Field>
        </>
      )}
    </div>
  );
}

// ── Scene (the outliner) ──

const kindIcon = (item: Item) =>
  item.kind === "mesh"
    ? "cube"
    : item.kind === "room"
    ? "home"
    : item.kind === "light"
    ? "sun"
    : "pin";

const NO_GROUPS: ItemGroup[] = [];

/** what is on the floor being edited: one row per item, a group as one row with its members under it */
export function ScenePanel() {
  const items = useEditor((s) => s.project.items);
  const groups = useEditor((s) => s.project.groups) ?? NO_GROUPS;
  const active = useEditor((s) => s.project.activeFloor);
  const selection = useEditor((s) => s.selection);
  const onFloor = items.filter((i) => i.floor === active);
  const pick = (id: string, e: { shiftKey: boolean; altKey: boolean }) =>
    select(id, { add: e.shiftKey, member: e.altKey });
  const row = (item: Item, indent = false) => (
    <ListRow
      key={item.id}
      icon={kindIcon(item)}
      title={item.name}
      subtitle={item.kind + (item.mover ? " · moving" : "")}
      selected={selection.includes(item.id)}
      style={indent ? { paddingLeft: 28 } : undefined}
      data-testid={`scene-${item.key ?? item.id}`}
      onClick={(e: { shiftKey: boolean; altKey: boolean }) => pick(item.id, e)}
    />
  );
  const grouped = groups.filter((g) => onFloor.some((i) => i.group === g.id));
  return (
    <div style={section} data-testid="scene-panel">
      {onFloor.length === 0
        ? (
          <Text small muted>
            Nothing on this floor yet: add something from Items, Shapes or Builders.
          </Text>
        )
        : (
          <Text small muted>
            Shift-click to select several; right-click → Group to move them as one. Alt-click a
            group's member to edit it alone.
          </Text>
        )}
      <List divided>
        {grouped.map((group) => {
          const members = onFloor.filter((i) => i.group === group.id);
          return [
            <ListRow
              key={group.id}
              icon="layers"
              title={group.name}
              subtitle={`group · ${members.length} items`}
              selected={members.every((m) => selection.includes(m.id))}
              data-testid={`scene-group-${group.id}`}
              onClick={(e: { shiftKey: boolean }) =>
                pick(members[0].id, { shiftKey: e.shiftKey, altKey: false })}
            />,
            ...members.map((m) => row(m, true)),
          ];
        })}
        {onFloor.filter((i) => !i.group || !groups.some((g) => g.id === i.group)).map((item) =>
          row(item)
        )}
      </List>
    </div>
  );
}

// ── Inspector ──

const OPENING_LABELS: Record<OpeningKind, string> = {
  door: "Door",
  double: "Double door",
  window: "Window",
  crawl: "Crawl hatch",
  arch: "Archway",
};

const toYaw = (q: Quat) =>
  Math.atan2(2 * (q[3] * q[2] + q[0] * q[1]), 1 - 2 * (q[1] * q[1] + q[2] * q[2]));
const fromYaw = (yaw: number): Quat => [0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2)];
const deg = (rad: number) => Math.round((rad * 180) / Math.PI * 10) / 10;

function Vec({ label, value, onChange, step = 0.1, unit = "m" }: {
  label: string;
  value: Vec3;
  onChange: (v: Vec3) => void;
  step?: number;
  unit?: string;
}) {
  return (
    <Field label={label}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
        {(["x", "y", "z"] as const).map((axis, i) => (
          <NumberInput
            key={axis}
            size="sm"
            value={value[i]}
            step={step}
            precision={2}
            unit={axis}
            aria-label={`${label} ${axis} (${unit})`}
            onChange={(v: number) => onChange(value.map((old, j) => (i === j ? v : old)) as Vec3)}
          />
        ))}
      </div>
    </Field>
  );
}

function Swatches({ value, onChange }: { value: Rgb; onChange: (c: Rgb) => void }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {Object.entries(PAINT).map(([name, color]) => (
        <button
          key={name}
          type="button"
          title={name}
          aria-label={name}
          onClick={() => onChange(color)}
          style={{
            width: 24,
            height: 24,
            borderRadius: "var(--radius-sm)",
            // the world's paint, shown as itself
            background: new THREE.Color(...color).getStyle(),
            border: color.every((c, i) => c === value[i])
              ? "2px solid var(--primary)"
              : "1px solid var(--border)",
            cursor: "pointer",
          }}
        />
      ))}
    </div>
  );
}

function Range({ label, value, min, max, step, unit, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <Field label={label}>
      <Slider
        value={value}
        min={min}
        max={max}
        step={step}
        aria-label={label}
        format={(v: number) => `${Number(v.toFixed(3))}${unit ? ` ${unit}` : ""}`}
        onChange={onChange}
      />
    </Field>
  );
}

function StairsEditor({ item }: { item: Extract<Item, { kind: "stairs" }> }) {
  const p = item.params;
  const floors = useEditor((s) => s.project.floors);
  const items = useEditor((s) => s.project.items);
  const set = (change: Partial<StairsParams>) =>
    updateItem(
      item.id,
      (i) => ({ ...i, params: { ...p, ...change } } as Item),
      `stairs-${item.id}`,
    );
  const here = floors.find((f) => f.id === item.floor);
  const above = floorAbove(floors, item.floor);
  const rise = above && here ? above.elevation - here.elevation - item.position[2] : 0;
  const climbs = Math.abs(p.steps * p.stepHeight - rise) < 0.01;
  const opened = above &&
    items.some((i) =>
      i.kind === "hole" && i.floor === above.id && i.name === `Opening for ${item.name}`
    );
  return (
    <>
      {above && (
        <>
          <Text small muted>
            Climbs {(p.steps * p.stepHeight).toFixed(2)} m; {above.name} is {rise.toFixed(2)} m up.
          </Text>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Button
              size="sm"
              icon="arrow-up"
              disabled={climbs}
              data-testid="stairs-reach"
              onClick={() => set(climbing(p, rise))}
            >
              Reach {above.name}
            </Button>
            <Button
              size="sm"
              icon="minus"
              disabled={Boolean(opened) || !above.slab}
              data-testid="stairs-opening"
              onClick={() => {
                const hole = openingAbove(item, above);
                addItems([hole]);
                // the floor above must reach past the top step, or the climb ends in the air
                if (above.slab) {
                  updateFloor(above.id, { slab: coveringSlab(above.slab, hole, 1.5) });
                }
              }}
            >
              {opened ? "Opening cut above" : `Cut an opening in ${above.name}`}
            </Button>
          </div>
        </>
      )}
      <Range
        label="Step height"
        value={p.stepHeight}
        min={0.05}
        max={0.4}
        step={0.01}
        unit="m"
        onChange={(stepHeight) => set({ stepHeight })}
      />
      <Range
        label="Step depth"
        value={p.stepDepth}
        min={0.15}
        max={0.8}
        step={0.01}
        unit="m"
        onChange={(stepDepth) => set({ stepDepth })}
      />
      <Range
        label="Width"
        value={p.width}
        min={0.4}
        max={4}
        step={0.05}
        unit="m"
        onChange={(width) => set({ width })}
      />
      <Range
        label="Steps"
        value={p.steps}
        min={1}
        max={30}
        step={1}
        onChange={(steps) => set({ steps })}
      />
      <Toggle
        value={Boolean(p.openRisers)}
        onChange={(openRisers: boolean) => set({ openRisers })}
        label="Open risers (gaps between steps, ladder-like)"
        data-testid="open-risers"
      />
      {p.openRisers && (
        <Range
          label="Tread thickness"
          value={p.treadThickness ?? 0.04}
          min={0.01}
          max={Math.max(0.02, p.stepHeight * 0.9)}
          step={0.005}
          unit="m"
          onChange={(treadThickness) => set({ treadThickness })}
        />
      )}
      <Field label="Shape">
        <Segmented
          size="sm"
          value={p.style ?? "straight"}
          items={[
            { value: "straight", label: "Straight" },
            { value: "switchback", label: "Switchback" },
            { value: "turn", label: "90° turn" },
            { value: "spiral", label: "Spiral" },
          ]}
          onChange={(style: string) => set({ style: style as StairsParams["style"] })}
          data-testid="stairs-style"
        />
      </Field>
      {p.style === "turn" && (
        <Field label="Turns">
          <Segmented
            size="sm"
            value={p.turnDirection ?? "left"}
            items={[
              { value: "left", label: "Left" },
              { value: "right", label: "Right" },
            ]}
            onChange={(turnDirection: string) =>
              set({ turnDirection: turnDirection as StairsParams["turnDirection"] })}
          />
        </Field>
      )}
      {p.style === "spiral" && (
        <>
          <Range
            label="Turn"
            value={p.spiralTurn ?? 360}
            min={90}
            max={720}
            step={15}
            unit="°"
            onChange={(spiralTurn) => set({ spiralTurn })}
          />
          <Range
            label="Center post"
            value={p.spiralCore ?? 0.1}
            min={0.05}
            max={0.6}
            step={0.01}
            unit="m"
            onChange={(spiralCore) => set({ spiralCore })}
          />
        </>
      )}
      <Field label="Railing">
        <Segmented
          size="sm"
          value={p.railing ?? "none"}
          items={[
            { value: "none", label: "None" },
            { value: "left", label: "Left" },
            { value: "right", label: "Right" },
            { value: "both", label: "Both" },
          ]}
          onChange={(railing: string) => set({ railing: railing as StairsParams["railing"] })}
          data-testid="stairs-railing"
        />
      </Field>
      {p.railing && p.railing !== "none" && p.style !== "spiral" && (
        <Field label="Railing style">
          <Segmented
            size="sm"
            value={p.railingStyle ?? "posts"}
            items={[
              { value: "posts", label: "Posts + rail" },
              { value: "panel", label: "Solid panel" },
              { value: "cables", label: "Cables" },
            ]}
            onChange={(railingStyle: string) =>
              set({ railingStyle: railingStyle as StairsParams["railingStyle"] })}
          />
        </Field>
      )}
      <Text small muted>
        Rise {(p.steps * p.stepHeight).toFixed(2)} m over {(p.steps * p.stepDepth).toFixed(2)}{" "}
        m (slope {deg(Math.atan2(p.stepHeight, p.stepDepth))}°)
      </Text>
      <Swatches value={p.color} onChange={(color) => set({ color })} />
    </>
  );
}

function HillEditor({ item }: { item: Extract<Item, { kind: "hill" }> }) {
  const p = item.params;
  const set = (change: Partial<HillParams>) =>
    updateItem(item.id, (i) => ({ ...i, params: { ...p, ...change } } as Item), `hill-${item.id}`);
  return (
    <>
      <Range
        label="Hill height"
        value={p.amplitude}
        min={0.05}
        max={3}
        step={0.05}
        unit="m"
        onChange={(amplitude) => set({ amplitude })}
      />
      <Range
        label="Roughness"
        value={p.roughness}
        min={0}
        max={0.9}
        step={0.05}
        onChange={(roughness) => set({ roughness })}
      />
      <Range
        label="Hills per 10 m"
        value={p.frequency}
        min={0.5}
        max={10}
        step={0.25}
        onChange={(frequency) => set({ frequency })}
      />
      <Range
        label="Detail (octaves)"
        value={p.octaves}
        min={1}
        max={7}
        step={1}
        onChange={(octaves) => set({ octaves })}
      />
      <Range
        label="Small bumps"
        value={p.bumps ?? 0}
        min={0}
        max={0.4}
        step={0.01}
        unit="m"
        onChange={(bumps) => set({ bumps })}
      />
      <Range
        label="Bump spacing"
        value={p.bumpSize ?? 0.6}
        min={0.2}
        max={3}
        step={0.05}
        unit="m"
        onChange={(bumpSize) => set({ bumpSize })}
      />
      <Range
        label="Size X"
        value={p.sizeX}
        min={2}
        max={60}
        step={0.5}
        unit="m"
        onChange={(sizeX) => set({ sizeX })}
      />
      <Range
        label="Size Y"
        value={p.sizeY}
        min={2}
        max={60}
        step={0.5}
        unit="m"
        onChange={(sizeY) => set({ sizeY })}
      />
      <Range
        label="Resolution"
        value={p.resolution}
        min={16}
        max={256}
        step={8}
        onChange={(resolution) => set({ resolution })}
      />
      <Field label="Seed">
        <div style={{ display: "flex", gap: 6 }}>
          <NumberInput value={p.seed} step={1} onChange={(seed: number) => set({ seed })} />
          <IconButton
            icon="refresh"
            label="New seed"
            onClick={() => set({ seed: Math.floor(Math.random() * 10000) })}
          />
        </div>
      </Field>
      <Toggle
        value={p.edgeFade}
        onChange={(edgeFade: boolean) => set({ edgeFade })}
        label="Fade to the ground at the edges"
      />
      <Swatches value={p.color} onChange={(color) => set({ color })} />
    </>
  );
}

function RoomEditor({ item }: { item: Extract<Item, { kind: "room" }> }) {
  const p = item.params;
  const set = (change: Partial<RoomParams>) =>
    updateItem(item.id, (i) => ({ ...i, params: { ...p, ...change } } as Item), `room-${item.id}`);
  const setDoor = (index: number, change: Partial<DoorOpening>) =>
    set({ doors: p.doors.map((d, i) => (i === index ? { ...d, ...change } : d)) });
  return (
    <>
      <Range
        label="Width (x)"
        value={p.width}
        min={1}
        max={30}
        step={0.1}
        unit="m"
        onChange={(width) => set({ width })}
      />
      <Range
        label="Depth (y)"
        value={p.depth}
        min={1}
        max={30}
        step={0.1}
        unit="m"
        onChange={(depth) => set({ depth })}
      />
      <Range
        label="Height"
        value={p.height}
        min={1}
        max={8}
        step={0.05}
        unit="m"
        onChange={(height) => set({ height })}
      />
      <Range
        label="Wall thickness"
        value={p.wallThickness}
        min={0.05}
        max={0.5}
        step={0.01}
        unit="m"
        onChange={(wallThickness) => set({ wallThickness })}
      />
      <Toggle
        value={p.ceiling}
        onChange={(ceiling: boolean) => set({ ceiling })}
        label="Ceiling"
        data-testid="room-ceiling"
      />
      <Toggle value={p.floor} onChange={(floor: boolean) => set({ floor })} label="Floor slab" />
      <p style={heading}>Doors and windows</p>
      {p.doors.map((door, index) => (
        <div
          key={index}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            paddingBottom: 6,
            borderBottom: "1px solid var(--hair)",
          }}
        >
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Badge>{OPENING_LABELS[door.kind ?? "door"]}</Badge>
            <Segmented
              size="sm"
              value={door.wall}
              items={["north", "south", "east", "west"].map((w) => ({
                value: w,
                label: w[0].toUpperCase(),
              }))}
              onChange={(wall: string) => setDoor(index, { wall: wall as DoorOpening["wall"] })}
            />
            <IconButton
              icon="trash"
              size="sm"
              variant="ghost"
              label="Remove opening"
              onClick={() => set({ doors: p.doors.filter((_, i) => i !== index) })}
            />
          </div>
          <Range
            label="Offset"
            value={door.offset}
            min={-10}
            max={10}
            step={0.1}
            unit="m"
            onChange={(offset) => setDoor(index, { offset })}
          />
          <Range
            label="Opening width"
            value={door.width}
            min={0.3}
            max={6}
            step={0.05}
            unit="m"
            onChange={(width) => setDoor(index, { width })}
          />
          <Range
            label="Sill height"
            value={door.bottom ?? 0}
            min={0}
            max={Math.max(0, p.height - 0.3)}
            step={0.05}
            unit="m"
            onChange={(bottom) => setDoor(index, { bottom })}
          />
          <Range
            label="Top"
            value={door.height}
            min={0.3}
            max={p.height}
            step={0.05}
            unit="m"
            onChange={(height) => setDoor(index, { height })}
          />
        </div>
      ))}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {(Object.keys(OPENING_LABELS) as OpeningKind[]).map((kind) => (
          <Button
            key={kind}
            size="sm"
            icon="plus"
            data-testid={`add-opening-${kind}`}
            onClick={() => set({ doors: [...p.doors, openingPreset(kind, "north")] })}
          >
            {OPENING_LABELS[kind]}
          </Button>
        ))}
      </div>
      <Swatches value={p.color} onChange={(color) => set({ color })} />
    </>
  );
}

function HoleEditor({ item }: { item: Extract<Item, { kind: "hole" }> }) {
  const p = item.params;
  const set = (change: Partial<HoleParams>) =>
    updateItem(item.id, (i) => ({ ...i, params: { ...p, ...change } } as Item), `hole-${item.id}`);
  const slab = useEditor((s) => s.project.floors.find((f) => f.id === item.floor)?.slab);
  return (
    <>
      <Range
        label="Size X"
        value={p.sizeX}
        min={0.2}
        max={20}
        step={0.1}
        unit="m"
        onChange={(sizeX) => set({ sizeX })}
      />
      <Range
        label="Size Y"
        value={p.sizeY}
        min={0.2}
        max={20}
        step={0.1}
        unit="m"
        onChange={(sizeY) => set({ sizeY })}
      />
      <Range
        label="Depth"
        value={p.depth}
        min={0.05}
        max={Math.max(0.1, slab?.thickness ?? 3)}
        step={0.05}
        unit="m"
        onChange={(depth) => set({ depth })}
      />
      <Text small muted>
        {slab
          ? p.depth >= slab.thickness
            ? "Cuts all the way through the floor."
            : "A pit: it keeps a bottom."
          : "This floor has no slab to cut: turn one on in Floors."}
      </Text>
      <Toggle
        value={Boolean(p.grate)}
        onChange={(on: boolean) => set({ grate: on ? defaultGrate() : undefined })}
        label="Drain grate"
        data-testid="hole-grate"
      />
      {p.grate && <GrateEditor grate={p.grate} onChange={(grate) => set({ grate })} />}
    </>
  );
}

function GrateEditor(
  { grate, onChange }: { grate: GrateParams; onChange: (grate: GrateParams) => void },
) {
  const set = (change: Partial<GrateParams>) => onChange({ ...grate, ...change });
  return (
    <>
      <Field label="Pattern">
        <Segmented
          size="sm"
          value={grate.pattern}
          items={[
            { value: "slats", label: "Slats" },
            { value: "grid", label: "Grid" },
          ]}
          onChange={(pattern: string) => set({ pattern: pattern as GrateParams["pattern"] })}
          data-testid="grate-pattern"
        />
      </Field>
      {grate.pattern === "slats" && (
        <Field label="Slats run along">
          <Segmented
            size="sm"
            value={grate.direction}
            items={[
              { value: "x", label: "X" },
              { value: "y", label: "Y" },
            ]}
            onChange={(direction: string) =>
              set({ direction: direction as GrateParams["direction"] })}
          />
        </Field>
      )}
      <Range
        label="Bar width"
        value={grate.barWidth}
        min={0.005}
        max={0.2}
        step={0.005}
        unit="m"
        onChange={(barWidth) => set({ barWidth })}
      />
      <Range
        label="Gap between bars"
        value={grate.gap}
        min={0.01}
        max={0.3}
        step={0.005}
        unit="m"
        onChange={(gap) => set({ gap })}
      />
      <Range
        label="Bar depth"
        value={grate.barDepth}
        min={0.01}
        max={0.3}
        step={0.01}
        unit="m"
        onChange={(barDepth) => set({ barDepth })}
      />
      <Text small muted>
        Every bar is a collision box flush with the floor: lidar sees down through the gaps, and
        feet can catch in them.
      </Text>
    </>
  );
}

function AprilTagEditor({ item }: { item: Extract<Item, { kind: "apriltag" }> }) {
  const p = item.params;
  const set = (change: Partial<AprilTagParams>) =>
    updateItem(item.id, (i) => ({ ...i, params: { ...p, ...change } } as Item), `tag-${item.id}`);
  return (
    <>
      <Field label="Tag id (tag36h11)">
        <NumberInput
          value={p.id}
          min={0}
          max={99}
          step={1}
          onChange={(id: number) => set({ id: Math.round(id) })}
        />
      </Field>
      <Range
        label="Tag size (black square)"
        value={p.size}
        min={0.05}
        max={1}
        step={0.01}
        unit="m"
        onChange={(size) => set({ size })}
      />
    </>
  );
}

function ImageEditor({ item }: { item: Extract<Item, { kind: "image" }> }) {
  const p = item.params;
  const set = (change: Partial<ImageParams>) =>
    updateItem(item.id, (i) => ({ ...i, params: { ...p, ...change } } as Item), `image-${item.id}`);
  return (
    <>
      <Field label="Width">
        <NumberInput
          value={p.width}
          min={0.01}
          step={0.05}
          unit="m"
          onChange={(width: number) => set({ width })}
        />
      </Field>
      <Field label="Height">
        <NumberInput
          value={p.height}
          min={0.01}
          step={0.05}
          unit="m"
          onChange={(height: number) => set({ height })}
        />
      </Field>
      <Range
        label="Opacity"
        value={p.opacity ?? 1}
        min={0.05}
        max={1}
        step={0.05}
        onChange={(opacity) => set({ opacity })}
      />
      <Toggle
        value={p.doubleSided ?? true}
        onChange={(doubleSided: boolean) => set({ doubleSided })}
        label="Seen from behind too"
      />
      <Text small muted>
        A reference photo: drawn here only, never collides, and is left out of the export.
      </Text>
    </>
  );
}

function LightEditor({ item }: { item: Extract<Item, { kind: "light" }> }) {
  const p = item.params;
  const set = (change: Partial<LightParams>) =>
    updateItem(item.id, (i) => ({ ...i, params: { ...p, ...change } } as Item), `light-${item.id}`);
  return (
    <>
      <Field label="Kind">
        <Segmented
          size="sm"
          value={p.type}
          items={[
            { value: "point", label: "Bulb" },
            { value: "spot", label: "Spot" },
            { value: "sun", label: "Sun" },
          ]}
          onChange={(type: string) => set({ type: type as LightParams["type"] })}
        />
      </Field>
      <Swatches value={p.color} onChange={(color) => set({ color })} />
      <Range
        label="Brightness"
        value={p.intensity}
        min={0}
        max={2}
        step={0.05}
        onChange={(intensity) => set({ intensity })}
      />
      {p.type !== "sun" && (
        <Range
          label="Reach"
          value={p.range}
          min={1}
          max={30}
          step={0.5}
          unit="m"
          onChange={(range) => set({ range })}
        />
      )}
      {p.type === "spot" && (
        <Range
          label="Cone half-angle"
          value={p.angle}
          min={5}
          max={89}
          step={1}
          unit="°"
          onChange={(angle) => set({ angle })}
        />
      )}
      <Toggle
        value={p.shadows}
        onChange={(shadows: boolean) => set({ shadows })}
        label="Casts shadows"
      />
      <Text small muted>
        Spots and suns shine down the item's -z: tilt it to aim. Lidar doesn't see light.
      </Text>
    </>
  );
}

function MoverEditor({ item }: { item: Item }) {
  const drawing = useEditor((s) => s.drawingPath === item.id);
  const mover = item.mover;
  if (!mover) {
    return (
      <Button
        icon="activity"
        data-testid="make-mover"
        onClick={() => {
          setMover(item.id, {
            waypoints: [[item.position[0], item.position[1], item.position[2]]],
            speed: 0.5,
            mode: "loop",
            heading: "path",
          });
          setDrawingPath(item.id);
        }}
      >
        Make it a moving object
      </Button>
    );
  }
  const set = (change: Partial<typeof mover>) => setMover(item.id, { ...mover, ...change });
  return (
    <>
      <ButtonGroup>
        <Button
          size="sm"
          icon="pointer"
          pressed={drawing}
          data-testid="draw-path"
          onClick={() => setDrawingPath(drawing ? null : item.id)}
        >
          {drawing ? "Done adding points" : "Click to add points"}
        </Button>
        <Button
          size="sm"
          icon="eraser"
          onClick={() => set({ waypoints: mover.waypoints.slice(0, 1) })}
        >
          Clear
        </Button>
        <Button size="sm" icon="close" variant="ghost" onClick={() => setMover(item.id, undefined)}>
          Stop moving
        </Button>
      </ButtonGroup>
      {drawing && (
        <Text small tone="warn">Click on the ground to add the next point of the path.</Text>
      )}
      <Range
        label="Speed"
        value={mover.speed}
        min={0.05}
        max={3}
        step={0.05}
        unit="m/s"
        onChange={(speed) => set({ speed })}
      />
      <Field label="Path">
        <Segmented
          size="sm"
          value={mover.mode}
          items={[{ value: "loop", label: "Loop" }, { value: "pingpong", label: "Back and forth" }]}
          onChange={(mode: string) => set({ mode: mode as typeof mover.mode })}
        />
      </Field>
      <Field label="Facing">
        <Segmented
          size="sm"
          value={mover.heading}
          items={[{ value: "path", label: "Along the path" }, { value: "fixed", label: "Fixed" }]}
          onChange={(heading: string) => set({ heading: heading as typeof mover.heading })}
        />
      </Field>
      <List divided>
        {mover.waypoints.map((w, i) => (
          <ListRow
            key={i}
            icon="pin"
            title={`Point ${i + 1}`}
            subtitle={w.map((v) => v.toFixed(1)).join(", ")}
            actions={
              <IconButton
                icon="close"
                size="sm"
                variant="ghost"
                label="Remove point"
                onClick={() => set({ waypoints: mover.waypoints.filter((_, j) => j !== i) })}
              />
            }
          />
        ))}
      </List>
      <Text small muted>
        In the simulation it is a kinematic body: it shoves the robot and is never pushed back;
        lidar sees it.
      </Text>
    </>
  );
}

function KeyInput({ id, value }: { id: string; value: string }) {
  const [draft, setDraft] = useState(value);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setDraft(value), [value]);
  const commit = () => setProblem(draft === value ? null : renameKey(id, draft));
  return (
    <>
      <TextInput
        value={draft}
        onChange={setDraft}
        onCommit={commit}
        onEnter={commit}
        mono
        invalid={Boolean(problem)}
      />
      {problem && <Text small tone="danger">{problem}</Text>}
    </>
  );
}

export function Inspector({ assets }: { assets: MeshAsset[] }) {
  const selected = useEditor((s) => s.selected);
  const item = useEditor((s) => s.project.items.find((i) => i.id === s.selected) ?? null);
  const floor = useEditor((s) => s.project.floors.find((f) => f.id === item?.floor));
  const activeFloor = useEditor((s) => s.project.activeFloor);
  const pickedFloor = useEditor((s) =>
    s.project.floors.find((f) => f.id === s.project.activeFloor)
  );
  if (!selected || !item) {
    return (
      <div style={section}>
        <Text small muted>
          Select something to edit it. T / R / S / E: move, rotate, scale, extend · Delete: remove ·
          Ctrl+D: duplicate · Ctrl+Z: undo.
        </Text>
        {pickedFloor && (
          <>
            <p style={heading}>Floor: {pickedFloor.name}</p>
            <FloorEditor floor={pickedFloor} />
          </>
        )}
      </div>
    );
  }
  const asset = item.kind === "mesh" ? assets.find((a) => a.id === item.params.asset) : undefined;
  const update = (change: Partial<Item>, key = "transform") =>
    updateItem(item.id, (i) => ({ ...i, ...change } as Item), `${key}-${item.id}`);
  return (
    <div style={section} data-testid="inspector">
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Icon name={item.kind === "room" ? "home" : "cube"} />
        <TextInput
          value={item.name}
          onChange={(name: string) => update({ name }, "name")}
          aria-label="Name"
        />
      </div>
      <Field
        label="Id"
        hint="the entity name in the exported scene; right-click an item to rename it"
      >
        <KeyInput id={item.id} value={item.key ?? ""} />
      </Field>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Badge>{item.kind === "primitive" ? item.params.shape : item.kind}</Badge>
        {asset && <Badge tone="info">{asset.hulls.length} collision hulls</Badge>}
        {item.mover && <Badge tone="warn">moving</Badge>}
      </div>
      <Vec
        label={floor && floor.elevation !== 0
          ? `Position (z above ${floor.name}, at ${floor.elevation.toFixed(1)} m)`
          : "Position"}
        value={item.position}
        onChange={(position) => update({ position })}
      />
      <Button
        size="sm"
        icon="arrow-down"
        data-testid="drop-to-surface"
        disabled={item.floor !== activeFloor}
        onClick={() =>
          update({
            position: [
              item.position[0],
              item.position[1],
              view.surfaceAt(item.position[0], item.position[1], item.id),
            ],
          })}
      >
        Drop onto what's below
      </Button>
      <Field label="Rotation (yaw)">
        <NumberInput
          value={deg(toYaw(item.rotation))}
          step={15}
          unit="°"
          onChange={(v: number) => update({ rotation: fromYaw((v * Math.PI) / 180) })}
        />
      </Field>
      {(item.kind === "primitive" || item.kind === "mesh") && (
        <Vec
          label={item.kind === "primitive" ? "Size" : "Scale"}
          value={item.scale}
          step={0.05}
          unit={item.kind === "primitive" ? "m" : "×"}
          onChange={(scale) => update({ scale })}
        />
      )}
      {item.kind === "primitive" && (
        <Swatches
          value={item.params.color}
          onChange={(color) =>
            update({ params: { ...item.params, color } } as Partial<Item>, "color")}
        />
      )}
      {item.kind === "stairs" && <StairsEditor item={item} />}
      {item.kind === "hill" && <HillEditor item={item} />}
      {item.kind === "room" && <RoomEditor item={item} />}
      {item.kind === "hole" && <HoleEditor item={item} />}
      {item.kind === "apriltag" && <AprilTagEditor item={item} />}
      {item.kind === "light" && <LightEditor item={item} />}
      {item.kind === "image" && <ImageEditor item={item} />}
      {!["hole", "apriltag", "light", "image"].includes(item.kind) && (
        <>
          <p style={heading}>Motion</p>
          <MoverEditor item={item} />
        </>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <Button size="sm" icon="copy" onClick={() => duplicateItem(item.id)}>Duplicate</Button>
        <Button size="sm" icon="trash" variant="danger" onClick={() => removeItem(item.id)}>
          Remove
        </Button>
      </div>
    </div>
  );
}

// ── Labels (annotations) ──

const NO_LABELS: Annotation[] = [];
const KIND_ICON = { point: "pin", path: "line", area: "grid" } as const;

/**
 * Labeled points, paths and areas on the floor being edited (exported as scene.json annotations): add one, click it
 * out on the floor, then name and tag it. A nav test is a preset: a path tagged nav:mapping, goals tagged nav:goal.
 */
export function LabelsPanel() {
  const labels = useEditor((s) => s.project.annotations) ?? NO_LABELS;
  const active = useEditor((s) => s.project.activeFloor);
  const tool = useEditor((s) => s.navTool);
  const tags = useEditor((s) => s.labelTags);
  const selected = useEditor((s) => s.selectedLabel);
  const onFloor = labels.filter((a) => a.floor === active);
  const drawing = tool === "point" || tool === "path" || tool === "area";
  const start = (kind: "point" | "path" | "area", preset: string[] = []) => {
    const same = tool === kind && preset.join() === tags.join();
    setNavTool(same ? null : kind, preset);
  };
  const open = labels.find((a) => a.id === selected);
  return (
    <div style={section} data-testid="labels-panel">
      <Text small muted>
        Labeled points, paths and areas for tests and tools to read (scene.json annotations). Add
        one, then click on the floor; Esc or Done when finished.
      </Text>
      <ButtonGroup>
        {(["point", "path", "area"] as const).map((kind) => (
          <Button
            key={kind}
            size="sm"
            icon={KIND_ICON[kind]}
            variant={tool === kind && tags.length === 0 ? "primary" : "default"}
            data-testid={`label-add-${kind}`}
            onClick={() => start(kind)}
          >
            {kind[0].toUpperCase() + kind.slice(1)}
          </Button>
        ))}
      </ButtonGroup>
      <p style={heading}>Nav test preset</p>
      <ButtonGroup>
        <Button
          size="sm"
          icon="line"
          variant={tool === "path" && tags.includes(NAV_MAPPING) ? "primary" : "default"}
          data-testid="nav-draw-path"
          onClick={() => start("path", [NAV_MAPPING])}
        >
          Mapping walk
        </Button>
        <Button
          size="sm"
          icon="target"
          variant={tool === "point" && tags.includes(NAV_GOAL) ? "primary" : "default"}
          data-testid="nav-add-goal"
          onClick={() => start("point", [NAV_GOAL])}
        >
          Goals
        </Button>
      </ButtonGroup>
      {drawing && (
        <Button size="sm" icon="check" variant="primary" onClick={() => setNavTool(null)}>
          Done {tool === "point" ? "placing points" : `drawing the ${tool}`}
        </Button>
      )}
      <List divided>
        {onFloor.map((a) => (
          <ListRow
            key={a.id}
            icon={KIND_ICON[a.kind]}
            title={a.label}
            subtitle={[a.kind, ...a.tags].join(" · ")}
            selected={a.id === selected}
            data-testid={`label-${a.id}`}
            onClick={() => selectLabel(a.id === selected ? null : a.id)}
          />
        ))}
      </List>
      {onFloor.length === 0 && <Text small muted>No labels on this floor yet.</Text>}
      {open && <LabelEditor label={open} />}
    </div>
  );
}

function LabelEditor({ label }: { label: Annotation }) {
  const [tagText, setTagText] = useState(label.tags.join(", "));
  useEffect(() => setTagText(label.tags.join(", ")), [label.id, label.tags.join()]);
  const set = (change: Partial<Annotation>) =>
    updateLabel(label.id, (a) => ({ ...a, ...change }), `label-${label.id}`);
  const goal = label.tags.includes(NAV_GOAL);
  const prop = (key: string, fallback: number) => Number(label.props?.[key] ?? fallback);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p style={heading}>{label.kind}</p>
      <Field label="Label">
        <TextInput
          value={label.label}
          onChange={(text: string) => set({ label: text })}
          data-testid="label-name"
        />
      </Field>
      <Field label="Tags (comma separated)">
        <TextInput
          value={tagText}
          mono
          onChange={setTagText}
          onBlur={() => set({ tags: tagText.split(",").map((t) => t.trim()).filter(Boolean) })}
          onEnter={() => set({ tags: tagText.split(",").map((t) => t.trim()).filter(Boolean) })}
          data-testid="label-tags"
        />
      </Field>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {[NAV_MAPPING, NAV_GOAL].filter((t) => !label.tags.includes(t)).map((t) => (
          <Button
            key={t}
            size="sm"
            variant="ghost"
            onClick={() => set({ tags: [...label.tags, t] })}
          >
            + {t}
          </Button>
        ))}
      </div>
      {label.kind === "area" && (
        <Range
          label="Height"
          value={label.height ?? 2}
          min={0.1}
          max={10}
          step={0.1}
          unit="m"
          onChange={(height) => set({ height })}
        />
      )}
      {label.kind !== "point" && (
        <Text small muted>
          {label.points?.length ?? 0} points.{" "}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setNavTool(label.kind as "path" | "area", label.tags);
              setLabelTarget(label.id);
            }}
          >
            Add more
          </Button>
        </Text>
      )}
      {goal && (
        <>
          <Range
            label="Reached within"
            value={prop("tolerance", 0.5)}
            min={0.1}
            max={3}
            step={0.05}
            unit="m"
            onChange={(tolerance) => set({ props: { ...label.props, tolerance } })}
          />
          <Range
            label="Time limit"
            value={prop("timeout", 120)}
            min={10}
            max={900}
            step={10}
            unit="s"
            onChange={(timeout) => set({ props: { ...label.props, timeout } })}
          />
        </>
      )}
      <Button size="sm" icon="trash" variant="danger" onClick={() => removeLabel(label.id)}>
        Remove
      </Button>
    </div>
  );
}

// ── Views ──

/**
 * Remembered camera views: save where the camera is, glide back to one with a click. Each exports as a MuJoCo camera
 * named by its id, so a test or an agent can look from exactly there (render_view() in the exported package).
 */
/** one shared empty list: a selector returning a fresh [] each call makes React re-render forever */
const NO_VIEWS: CameraView[] = [];

export function ViewsPanel() {
  const views = useEditor((s) => s.project.views ?? NO_VIEWS);
  const [current, setCurrent] = useState<string | null>(null);
  const chosen = views.find((v) => v.key === current) ?? null;
  const go = (key: string) => {
    const saved = views.find((v) => v.key === key);
    if (!saved) return;
    setCurrent(key);
    view.camera?.goTo(saved.eye, saved.target, saved.fov);
  };
  return (
    <div style={section} data-testid="views-panel">
      <Text small muted>
        Remembered camera views. Each exports as a MuJoCo camera named by its id, for agents and
        tests to look from (render_view in the exported package, or GET api/views/image).
      </Text>
      <Button
        icon="camera"
        data-testid="save-view"
        onClick={() => {
          const camera = view.camera?.get();
          if (camera) setCurrent(saveView(camera));
        }}
      >
        Save this view
      </Button>
      {views.length === 0 && <Text small muted>No views yet.</Text>}
      <List divided>
        {views.map((v) => (
          <ListRow
            key={v.key}
            icon="eye"
            title={v.name}
            subtitle={v.key}
            selected={v.key === current}
            onClick={() => go(v.key)}
            data-testid={`view-${v.key}`}
          />
        ))}
      </List>
      {chosen && <ViewEditor key={chosen.key} saved={chosen} onRenamed={setCurrent} />}
    </div>
  );
}

function ViewEditor({ saved, onRenamed }: { saved: CameraView; onRenamed: (key: string) => void }) {
  const [draft, setDraft] = useState(saved.name);
  const [problem, setProblem] = useState<string | null>(null);
  const commit = () => {
    if (draft === saved.name) return;
    const failed = renameView(saved.key, draft);
    setProblem(failed);
    if (!failed) onRenamed(slug(draft).replace(/^item_/, "view_"));
  };
  return (
    <>
      <Field label="Name">
        <TextInput
          value={draft}
          onChange={setDraft}
          onCommit={commit}
          onEnter={commit}
          data-testid="view-name"
        />
      </Field>
      {problem && <Text small tone="danger">{problem}</Text>}
      <Text small muted>
        Id <code>{saved.key}</code> · from {saved.eye.map((v) => v.toFixed(1)).join(", ")} ·{" "}
        {saved.fov}° fov
      </Text>
      <ButtonGroup>
        <Button
          size="sm"
          icon="refresh"
          onClick={() => {
            const camera = view.camera?.get();
            if (camera) updateView(saved.key, camera);
          }}
        >
          Set to this camera
        </Button>
        <Button size="sm" icon="trash" variant="danger" onClick={() => removeView(saved.key)}>
          Delete
        </Button>
      </ButtonGroup>
    </>
  );
}

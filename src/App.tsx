import { Component, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import type { Object3D } from "three";
import * as api from "./api.ts";
import {
  Button,
  ButtonGroup,
  Checkbox,
  CodeBlock,
  Field,
  IconButton,
  List,
  ListRow,
  Menu,
  Modal,
  NumberInput,
  Progress,
  Segmented,
  Tabs,
  Text,
  TextInput,
  toast,
  Toggle,
  useBackendEvents,
} from "./ui.ts";
import { emptyProject } from "./world/defaults.ts";
import { testCourse } from "./world/examples.ts";
import { clutterYard } from "./world/examples_clutter.ts";
import { office555 } from "./world/examples_office.ts";
import type { MeshAsset, Project, Vec3 } from "./world/types.ts";
import { packageName } from "./world/keys.ts";
import {
  BuildersPanel,
  Inspector,
  LabelsPanel,
  LibraryPanel,
  ScenePanel,
  ShapesPanel,
  ViewsPanel,
} from "./editor/Panels.tsx";
import { Viewport } from "./editor/Viewport.tsx";
import { ClipBadge } from "./editor/ClipBadge.tsx";
import { layoutCss, Sheet, SidePanel, usePhone } from "./editor/Layout.tsx";
import {
  addItem,
  duplicateItem,
  getState,
  groupSelection,
  loadProject,
  openMenu,
  redo,
  refreshProject,
  removeItem,
  removeSelection,
  renameKey,
  renameProject,
  select,
  setActiveFloor,
  setDrawingPath,
  setFancy,
  setGizmo,
  setMode,
  setNavTool,
  setPreviewMotion,
  setShowCollision,
  setSnap,
  subscribe,
  undo,
  ungroup,
  useEditor,
  useMenu,
} from "./editor/store.ts";
import { makeItem } from "./world/defaults.ts";
import { cameraListeners, view } from "./editor/palette.ts";

type Tab = "shapes" | "items" | "builders" | "scene" | "nav" | "views";

export function App() {
  const [assets, setAssets] = useState<MeshAsset[]>([]);
  const [tab, setTab] = useState<Tab>("items");
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const mode = useEditor((s) => s.mode);
  const project = useEditor((s) => s.project);
  const revision = useEditor((s) => s.revision);
  const assetMap = useAssetMap(assets);

  const refreshAssets = useCallback(
    () =>
      api.library().then(setAssets).catch((e) =>
        toast({ title: "Library", message: String(e), tone: "danger" })
      ),
    [],
  );
  useEffect(() => {
    refreshAssets();
    // ?open=<name>: a saved world (POST api/open sends Desktop here); #example opens the test course (handy for
    // demos); otherwise the last world worked on
    const asked = new URLSearchParams(location.search).get("open");
    if (asked) {
      history.replaceState(null, "", location.pathname + location.hash);
      openSaved(asked);
      return;
    }
    if (location.hash === "#example" || location.hash === "#clutter") {
      loadProject(location.hash === "#example" ? testCourse() : clutterYard());
      return;
    }
    const last = localStorageGet("dim-world-builder.project");
    if (last) api.loadProject(last).then(loadSaved).catch(() => {});
  }, [refreshAssets]);

  // POST api/open (an agent, or this page's own Open dialog) announces the world to switch to
  useBackendEvents((event: { name?: string }) => {
    if (event?.name) openSaved(event.name);
  }, { topic: "open" });

  // the API changed a saved world: if it's this one, show the change live
  useBackendEvents((event: { name?: string }) => {
    if (event?.name && event.name === packageName(getState().project.name)) {
      changedElsewhere(event.name);
    }
  }, { topic: "changed" });

  // POST api/pages/reload: a full reload (a new build), after saving what's unsaved; a refused save keeps the page as is
  useBackendEvents((event: { world?: string }) => {
    if (event?.world && event.world !== packageName(getState().project.name)) return;
    if (autosaveHeld) return;
    if (getState().revision === savedRevision) location.reload();
    else save(false).finally(() => !autosaveHeld && location.reload());
  }, { topic: "reload" });

  // autosave: the project file in the app's data folder, a moment after the last change
  useEffect(() => {
    if (revision === 0 || autosaveHeld) return;
    const timer = setTimeout(() => save(false), 800);
    return () => clearTimeout(timer);
  }, [revision]);

  useSelectionReport();
  useCameraReport();
  // POST api/camera: an agent moves the view (of the pages in front)
  useBackendEvents((event: { position?: Vec3; target?: Vec3; fov?: number; item_id?: string }) => {
    if (document.visibilityState !== "visible" || !view.camera) return;
    if (event?.item_id && view.camera.frame(event.item_id)) return;
    const now = view.camera.get();
    if (event?.position || event?.target) {
      view.camera.goTo(event.position ?? now.eye, event.target ?? now.target, event.fov ?? now.fov);
    }
  }, { topic: "camera" });
  // POST api/highlight: an agent points at items
  useBackendEvents((event: { ids?: string[]; seconds?: number }) => {
    if (event?.ids?.length) view.camera?.blink(event.ids, event.seconds ?? 3);
  }, { topic: "highlight" });
  useKeyboard();
  const phone = usePhone();
  const [sheet, setSheet] = useState<"tools" | "inspector" | null>(null);
  // a sheet covers the view, so it gets out of the way once something lands or wants a tap in the world
  const itemCount = useEditor((s) => s.project.items.length);
  const wantsTap = useEditor((s) => s.navTool !== null || s.drawingPath !== null);
  const lastCount = useRef(itemCount);
  useEffect(() => {
    if (itemCount > lastCount.current || wantsTap) setSheet(null);
    lastCount.current = itemCount;
  }, [itemCount, wantsTap]);

  const toolPanel = (
    <>
      <Tabs
        value={tab}
        onChange={(t: string) => setTab(t as Tab)}
        items={[
          { value: "items", label: "Items" },
          { value: "shapes", label: "Shapes" },
          { value: "builders", label: "Builders" },
          { value: "scene", label: "Scene" },
          { value: "nav", label: "Labels" },
          { value: "views", label: "Views" },
        ]}
        style={{ padding: "0 8px", ...(phone && { overflowX: "auto", flex: "none" }) }}
      />
      <div
        style={{ flex: 1, overflow: "auto", paddingBottom: "var(--dim-inset-bottom, 0px)" }}
        data-testid="sidebar"
      >
        <PanelBoundary key={tab}>
          {tab === "items" && (
            <LibraryPanel
              assets={assets}
              onImport={() => setImporting(true)}
            />
          )}
          {tab === "shapes" && <ShapesPanel />}
          {tab === "builders" && <BuildersPanel />}
          {tab === "scene" && <ScenePanel />}
          {tab === "nav" && <LabelsPanel />}
          {tab === "views" && <ViewsPanel />}
        </PanelBoundary>
      </div>
    </>
  );
  const inspector = <Inspector assets={assets} />;

  return (
    <div
      className={phone ? "dwb-phone" : undefined}
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        color: "var(--fg)",
      }}
    >
      <style>{layoutCss}</style>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: phone ? 6 : 10,
          padding: phone ? "6px 8px" : "8px 12px",
          borderBottom: "1px solid var(--border)",
          background: "var(--surface)",
        }}
      >
        <TextInput
          value={project.name}
          onChange={renameProject}
          aria-label="World name"
          style={phone ? { flex: "1 1 0", minWidth: 0 } : { maxWidth: 240 }}
          data-testid="world-name"
        />
        <ProjectMenu phone={phone} />
        <SaveMenu phone={phone} />
        {!phone && <div style={{ flex: 1 }} />}
        <ClipBadge />
        <Segmented
          value={mode}
          items={[{ value: "edit", label: "Edit" }, { value: "view", label: "Viewer" }]}
          onChange={(m: string) => setMode(m as "edit" | "view")}
          data-testid="mode"
        />
        {phone
          ? (
            <IconButton
              icon="download"
              label="Export"
              variant="primary"
              onClick={() => setExporting(true)}
              data-testid="export"
            />
          )
          : (
            <Button
              variant="primary"
              icon="download"
              onClick={() => setExporting(true)}
              data-testid="export"
            >
              Export
            </Button>
          )}
      </header>
      <div style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>
        {mode === "edit" && !phone && (
          <SidePanel
            side="left"
            storageKey="dim-world-builder.panel-left"
            defaultWidth={330}
            style={{ display: "flex", flexDirection: "column", background: "var(--surface)" }}
          >
            {toolPanel}
          </SidePanel>
        )}
        <main style={{ flex: 1, position: "relative", minWidth: 0 }}>
          <Viewport assets={assetMap} />
          {mode === "edit" ? <EditToolbar phone={phone} /> : <ViewerOverlay />}
          {mode === "edit" && <FloorPicker />}
          {mode === "edit" && !phone && (
            <div
              style={{
                position: "absolute",
                bottom: 10,
                left: "50%",
                transform: "translateX(-50%)",
                pointerEvents: "none",
                opacity: 0.7,
                font: "12px system-ui",
                color: "var(--muted, #aaa)",
                textShadow: "0 1px 2px rgba(0,0,0,.6)",
                whiteSpace: "nowrap",
              }}
            >
              drag: pan · shift/right-drag: orbit · wheel: zoom · shift-click: add to selection
            </div>
          )}
        </main>
        {mode === "edit" && !phone && (
          <SidePanel
            side="right"
            storageKey="dim-world-builder.panel-right"
            defaultWidth={320}
            style={{ display: "flex", flexDirection: "column", background: "var(--surface)" }}
          >
            {/* the scroller is inside, so the resize edge (over the border) isn't clipped */}
            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflow: "auto",
                paddingBottom: "var(--dim-inset-bottom, 0px)",
              }}
            >
              {inspector}
            </div>
          </SidePanel>
        )}
        {mode === "edit" && phone && (
          <>
            <Sheet
              open={sheet === "tools"}
              title="Add to the world"
              onClose={() => setSheet(null)}
              testId="sheet-tools"
            >
              {toolPanel}
            </Sheet>
            <Sheet
              open={sheet === "inspector"}
              title="Inspector"
              onClose={() => setSheet(null)}
              testId="sheet-inspector"
            >
              <div style={{ flex: 1, overflow: "auto" }}>{inspector}</div>
            </Sheet>
          </>
        )}
      </div>
      {mode === "edit" && phone && (
        <div
          data-testid="phone-bar"
          style={{
            display: "flex",
            gap: 8,
            padding: "6px 8px",
            paddingBottom: "calc(6px + var(--dim-inset-bottom, env(safe-area-inset-bottom, 0px)))",
            borderTop: "1px solid var(--border)",
            background: "var(--surface)",
          }}
        >
          <Button
            icon="plus"
            style={{ flex: 1 }}
            pressed={sheet === "tools"}
            onClick={() => setSheet(sheet === "tools" ? null : "tools")}
            data-testid="open-tools"
          >
            Add
          </Button>
          <IconButton icon="rotate-left" label="Undo" onClick={undo} />
          <IconButton icon="rotate-right" label="Redo" onClick={redo} />
          <Button
            icon="settings"
            style={{ flex: 1 }}
            pressed={sheet === "inspector"}
            onClick={() => setSheet(sheet === "inspector" ? null : "inspector")}
            data-testid="open-inspector"
          >
            Inspect
          </Button>
        </div>
      )}
      <ImportDialog
        open={importing}
        onClose={() => setImporting(false)}
        onCooked={async (asset) => {
          await refreshAssets();
          setShowCollision(true);
          addItem(makeItem("mesh", { source: "import", asset: asset.id }, {
            name: asset.name,
            floor: getState().project.activeFloor,
            position: [view.center[0], view.center[1], 0],
          }));
        }}
      />
      <ExportDialog open={exporting} onClose={() => setExporting(false)} />
      <ItemMenu />
    </div>
  );
}

function useAssetMap(assets: MeshAsset[]) {
  const [map, setMap] = useState<Record<string, MeshAsset>>({});
  useEffect(() => setMap(Object.fromEntries(assets.map((a) => [a.id, a]))), [assets]);
  return map;
}

// the same world asked for twice within a moment (the dialog loads it, then api/open's announcement arrives) loads once
let lastOpened = { name: "", at: 0 };
function openSaved(name: string) {
  if (name === lastOpened.name && Date.now() - lastOpened.at < 3000) return;
  lastOpened = { name, at: Date.now() };
  api.loadProject(name).then(loadSaved).catch((e) =>
    toast({ title: "Open", message: `${name}: ${e}`, tone: "danger" })
  );
}

// the revision last saved (or loaded): a newer one means edits not yet on the server
let savedRevision = 0;
// a save was refused (the world changed elsewhere and couldn't be merged): no autosave until the user picks
let autosaveHeld = false;

function loadSaved(project: Project) {
  loadProject(project);
  savedRevision = getState().revision;
  autosaveHeld = false;
}

/** take the saved world as it is now (keeping the view and the selection) */
function pullLatest(name: string) {
  return api.loadProject(name).then((project) => {
    refreshProject(project);
    savedRevision = getState().revision;
    autosaveHeld = false;
  }).catch((e) => toast({ title: "Update", message: `${name}: ${e}`, tone: "danger" }));
}

/**
 * Saves the page's world. The backend knows which version this page started from: if the world changed since (an
 * agent's edit), it keeps those changes and applies only the items this page changed, and the page takes the result.
 */
function save(announce: boolean) {
  const { project, revision } = getState();
  localStorageSet("dim-world-builder.project", project.name);
  return api.saveProject(project).then((r) => {
    savedRevision = Math.max(savedRevision, revision);
    autosaveHeld = false;
    // edits made while it saved go out with the next save (and its merge)
    if (r.merged && getState().revision === revision) {
      refreshProject(r.merged);
      savedRevision = getState().revision;
    }
    if (r.merged) {
      toast({
        id: "changed-elsewhere",
        title: "Merged",
        message: `${packageName(project.name)} had changed elsewhere: your edits were added to it`,
      });
    }
    if (announce) {
      toast({
        title: "Saved",
        message: r.alsoSaved ? `${project.name} → ${r.alsoSaved}` : project.name,
        tone: "ok",
      });
    }
  }).catch((e) => {
    if (!(e instanceof api.SaveConflict)) {
      if (announce) toast({ title: "Save failed", message: String(e), tone: "danger" });
      return;
    }
    autosaveHeld = true;
    const name = packageName(project.name);
    toast({
      id: "changed-elsewhere",
      title: "Changed outside this page",
      message:
        `${name} was changed elsewhere and your unsaved edits couldn't be merged into it. They're kept here, unsaved: load the new version (dropping them), or Save as… to keep yours elsewhere.`,
      tone: "warn",
      durationMs: 0,
      action: { label: "Load new version", onClick: () => pullLatest(name) },
    });
  });
}

/** the open world was changed through the API: take it live; with unsaved edits here, save them now (merged into it) */
function changedElsewhere(name: string) {
  if (autosaveHeld) return;
  if (getState().revision === savedRevision) {
    pullLatest(name);
    return;
  }
  save(false);
}

/** save right away (autosave also does, a moment after each change); says where it went */
function saveNow() {
  save(true);
}

function localStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function localStorageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private window
  }
}

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveNow();
        return;
      }
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]")) {
        // Esc in a field leaves the field (and the selection alone)
        if (e.key === "Escape") target.blur();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      const selected = getState().selected;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        (e.shiftKey ? redo : undo)();
      } else if (mod && e.key.toLowerCase() === "d" && selected) {
        e.preventDefault();
        duplicateItem(selected);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        removeSelection();
      } else if (e.key === "Escape") {
        // undo first what's in progress: a gizmo drag (back to where it began), a path being drawn, a tool;
        // then the selection, all of it
        const gizmo = (globalThis as unknown as {
          dimWorldBuilderGizmo?: {
            dragging: boolean;
            reset(): void;
            pointerUp(p: { button: number }): void;
          };
        }).dimWorldBuilderGizmo;
        if (gizmo?.dragging) {
          gizmo.reset();
          gizmo.pointerUp({ button: 0 });
        } else if (getState().navTool) setNavTool(null);
        else if (getState().drawingPath) setDrawingPath(null);
        else select(null);
      } else if (!mod && getState().mode === "edit") {
        const key = e.key.toLowerCase();
        if (key === "t") setGizmo("translate");
        if (key === "r") setGizmo("rotate");
        if (key === "s") setGizmo("scale");
        if (key === "e") setGizmo("extend");
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
}

/** over the view's top-left: the gizmo, the view's switches, undo/redo; a phone keeps the switches behind a button */
function EditToolbar({ phone }: { phone: boolean }) {
  const gizmo = useEditor((s) => s.gizmo);
  const snap = useEditor((s) => s.snap);
  const showCollision = useEditor((s) => s.showCollision);
  const previewMotion = useEditor((s) => s.previewMotion);
  const navTool = useEditor((s) => s.navTool);
  const [more, setMore] = useState(false);
  const switches = (
    <>
      <Toggle size="sm" value={snap} onChange={setSnap} label="Snap" />
      <Toggle
        size="sm"
        value={showCollision}
        onChange={setShowCollision}
        label="Collision"
        data-testid="show-collision"
      />
      <FancyToggle />
      <Toggle
        size="sm"
        value={previewMotion}
        onChange={setPreviewMotion}
        label="Play motion"
        data-testid="preview-motion"
      />
    </>
  );
  return (
    <div
      data-testid="edit-toolbar"
      style={{
        position: "absolute",
        left: phone ? 8 : 12,
        top: phone ? 8 : 12,
        // clear of the view cube
        maxWidth: phone ? "calc(100% - 120px)" : "calc(100% - 170px)",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: phone ? 6 : 8,
        padding: 6,
        borderRadius: "var(--radius-lg)",
        background: "var(--panel, var(--raised))",
        boxShadow: "var(--shadow)",
      }}
    >
      <Segmented
        size="sm"
        value={gizmo}
        items={phone
          ? [
            { value: "translate", label: "Move" },
            { value: "rotate", label: "Rotate" },
            { value: "scale", label: "Scale" },
            { value: "extend", label: "Extend" },
          ]
          : [
            { value: "translate", label: "Move (T)" },
            { value: "rotate", label: "Rotate (R)" },
            { value: "scale", label: "Scale (S)" },
            { value: "extend", label: "Extend (E)" },
          ]}
        onChange={(g: string) => setGizmo(g as "translate")}
        data-testid="gizmo"
      />
      {phone
        ? (
          <IconButton
            icon="more-horizontal"
            label="View switches"
            size="sm"
            variant={more ? "primary" : "default"}
            onClick={() => setMore(!more)}
            data-testid="toolbar-more"
          />
        )
        : switches}
      {phone && more && (
        <div style={{ flexBasis: "100%", display: "flex", flexDirection: "column", gap: 2 }}>
          {switches}
        </div>
      )}
      {navTool === "tag" && (
        <Button
          size="sm"
          icon="close"
          onClick={() => setNavTool(null)}
          data-testid="tag-tool-done"
        >
          Placing AprilTags: click a wall · Done
        </Button>
      )}
      {!phone && <IconButton icon="rotate-left" label="Undo" size="sm" onClick={undo} />}
      {!phone && <IconButton icon="rotate-right" label="Redo" size="sm" onClick={redo} />}
    </div>
  );
}

/** the floors as a stack of buttons over the view's bottom-left corner (top floor on top): the lit one is edited */
function FloorPicker() {
  const floors = useEditor((s) => s.project.floors);
  const active = useEditor((s) => s.project.activeFloor);
  if (floors.length < 2) return null;
  return (
    <div
      data-testid="floor-picker"
      style={{
        position: "absolute",
        left: 12,
        bottom: 12,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: 6,
        borderRadius: "var(--radius-lg)",
        background: "var(--panel, var(--raised))",
        boxShadow: "var(--shadow)",
      }}
    >
      {[...floors].sort((a, b) => b.elevation - a.elevation).map((floor) => (
        <Button
          key={floor.id}
          size="sm"
          variant={floor.id === active ? "primary" : "ghost"}
          data-testid={`floor-pick-${floor.id}`}
          onClick={() => {
            setActiveFloor(floor.id);
            // nothing selected, so the inspector shows the floor's settings
            select(null);
          }}
        >
          {floor.name} · {floor.elevation.toFixed(1)} m
        </Button>
      ))}
    </div>
  );
}

/** a panel that throws shows its error in place, instead of taking the whole app down with it */
class PanelBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error) {
    console.error("World Builder panel failed:", error);
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}
        data-testid="panel-error"
      >
        <Text small tone="danger">This panel hit an error: {this.state.error.message}</Text>
        <Button size="sm" onClick={() => this.setState({ error: null })}>Try again</Button>
      </div>
    );
  }
}

const FANCY_PARTS = [
  ["grass", "Grass (and wind)"],
  ["shadows", "Soft shadows"],
  ["occlusion", "Floor shading under furniture"],
  ["detail", "Surface detail (wood, fabric, metal, floors)"],
  ["sky", "Sky and haze"],
] as const;

/** one switch for the costly eye candy, and a chevron that opens a checkbox per part */
function FancyToggle() {
  const fancy = useEditor((s) => s.fancy);
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 2 }}>
      <Toggle
        size="sm"
        value={fancy.on}
        onChange={(on: boolean) => setFancy({ on })}
        label="Fancy rendering"
        data-testid="fancy"
      />
      <IconButton
        icon={open ? "chevron-up" : "chevron-down"}
        label="Choose what fancy rendering draws"
        size="sm"
        variant="ghost"
        data-testid="fancy-parts"
        onClick={() => setOpen(!open)}
      />
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 20,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: 10,
            width: 260,
            borderRadius: "var(--radius-lg)",
            background: "var(--raised)",
            border: "1px solid var(--border)",
            boxShadow: "var(--shadow-lg)",
          }}
        >
          {FANCY_PARTS.map(([key, label]) => (
            <Checkbox
              key={key}
              value={fancy[key]}
              disabled={!fancy.on}
              onChange={(on: boolean) => setFancy({ [key]: on })}
              label={label}
              data-testid={`fancy-${key}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectMenu({ phone }: { phone: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {phone
        ? (
          <IconButton
            icon="folder"
            label="Open"
            onClick={() => setOpen(true)}
            data-testid="open-world"
          />
        )
        : (
          <Button icon="folder" size="sm" onClick={() => setOpen(true)} data-testid="open-world">
            Open
          </Button>
        )}
      <OpenDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

type OpenTab = "saved" | "examples" | "file";

/** Open a world: a saved one, an example, a blank one, or any project file / export folder (or an upload) */
function OpenDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<OpenTab>("saved");
  const [projects, setProjects] = useState<string[]>([]);
  const [folder, setFolder] = useState(() =>
    localStorageGet("dim-world-builder.open-folder") ?? "~"
  );
  const [listing, setListing] = useState<api.DirListing | null>(null);
  const [busy, setBusy] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const current = useEditor((s) => s.project.name);
  useEffect(() => {
    if (open) api.listProjects().then((r) => setProjects(r.projects)).catch(() => {});
  }, [open]);
  useEffect(() => {
    if (!open || tab !== "file") return;
    api.listDirs(folder).then(setListing).catch(() => setListing(null));
    localStorageSet("dim-world-builder.open-folder", folder);
  }, [open, tab, folder]);
  const done = (project: Parameters<typeof loadProject>[0]) => {
    loadProject(project);
    onClose();
  };
  // a file: the backend adopts it among the saved worlds (a project file keeps saving back to itself), then it loads
  const openFile = async (body: { path?: string; project?: unknown }) => {
    setBusy(true);
    try {
      const result = await api.openWorld({ ...body, show: false });
      openSaved(result.opened);
      if (result.savesTo) toast({ title: "Opened", message: `edits save to ${result.savesTo}` });
      onClose();
    } catch (error) {
      toast({ title: "Open", message: String(error), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };
  const join = (name: string) => `${listing?.path.replace(/\/$/, "") ?? folder}/${name}`;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Open a world"
      size="lg"
      footer={
        <Button
          icon="plus"
          data-testid="open-new"
          onClick={() =>
            done(emptyProject(`world_${new Date().toISOString().slice(5, 10).replace("-", "")}`))}
        >
          New empty world
        </Button>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Tabs
          value={tab}
          onChange={(t: string) => setTab(t as OpenTab)}
          items={[
            { value: "saved", label: "Saved" },
            { value: "examples", label: "Examples" },
            { value: "file", label: "File" },
          ]}
        />
        <div style={{ height: 360, overflow: "auto" }}>
          {tab === "saved" && (
            <List divided>
              {projects.map((name) => (
                <ListRow
                  key={name}
                  icon="map"
                  title={name}
                  selected={name === current}
                  onClick={() => {
                    openSaved(name);
                    onClose();
                  }}
                  data-testid={`open-saved-${name}`}
                />
              ))}
            </List>
          )}
          {tab === "examples" && (
            <List divided>
              <ListRow icon="map" title="Nav test course" onClick={() => done(testCourse())} />
              <ListRow icon="map" title="Cluttered yard" onClick={() => done(clutterYard())} />
              <ListRow icon="map" title="The office (555)" onClick={() => done(office555())} />
            </List>
          )}
          {tab === "file" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <TextInput
                  value={folder}
                  onChange={setFolder}
                  mono
                  style={{ flex: 1 }}
                  aria-label="Folder or file"
                  data-testid="open-path"
                />
                <Button
                  loading={busy}
                  disabled={!folder.endsWith(".json")}
                  onClick={() => openFile({ path: folder })}
                >
                  Open path
                </Button>
                <Button icon="upload" onClick={() => upload.current?.click()}>Upload…</Button>
                <input
                  ref={upload}
                  type="file"
                  accept=".json,application/json"
                  hidden
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    try {
                      await openFile({ project: JSON.parse(await file.text()) });
                    } catch (error) {
                      toast({ title: "Open", message: `${file.name}: ${error}`, tone: "danger" });
                    }
                  }}
                />
              </div>
              <Text small muted>
                A project .json (edits keep saving back to it), or an exported world's folder (opens
                a copy).
              </Text>
              {listing?.error && <Text tone="danger">{listing.error}</Text>}
              {listing && !listing.error && (
                <List divided>
                  <ListRow icon="arrow-up" title=".." onClick={() => setFolder(listing.parent)} />
                  {listing.dirs.map((d) =>
                    listing.worlds.includes(d)
                      ? (
                        <ListRow
                          key={d}
                          icon="map"
                          title={d}
                          subtitle="exported world"
                          onClick={() => openFile({ path: join(d) })}
                        />
                      )
                      : (
                        <ListRow
                          key={d}
                          icon="folder"
                          title={d}
                          onClick={() => setFolder(join(d))}
                        />
                      )
                  )}
                  {listing.files.map((f) => (
                    <ListRow
                      key={f}
                      icon="file"
                      title={f}
                      onClick={() => openFile({ path: join(f) })}
                    />
                  ))}
                </List>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function SaveMenu({ phone }: { phone: boolean }) {
  const [saveAs, setSaveAs] = useState(false);
  return (
    <>
      <ButtonGroup>
        {phone
          ? <IconButton icon="check" label="Save" onClick={saveNow} data-testid="save" />
          : (
            <Button icon="check" size="sm" onClick={saveNow} title="Save (⌘S)" data-testid="save">
              Save
            </Button>
          )}
        <Menu
          trigger={<IconButton icon="chevron-down" label="More save options" size="sm" />}
          items={[{ label: "Save as file…", icon: "file", onSelect: () => setSaveAs(true) }]}
        />
      </ButtonGroup>
      <SaveAsDialog open={saveAs} onClose={() => setSaveAs(false)} />
    </>
  );
}

/** write the world to a .json anywhere; from then on its saves go there too */
function SaveAsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const name = useEditor((s) => s.project.name);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    const fallback = `~/dimos_worlds/${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_")}.json`;
    setPath(fallback);
    api.linkedFiles().then((links) => {
      const linked = links[name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_")];
      if (linked) setPath(linked);
    }).catch(() => {});
  }, [open, name]);
  const save = async () => {
    setBusy(true);
    try {
      const result = await api.saveAs(getState().project, path);
      toast({
        title: "Saved",
        message: `${name} → ${result.saved} (later saves go there too)`,
        tone: "ok",
      });
      onClose();
    } catch (error) {
      toast({ title: "Save failed", message: String(error), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save as file"
      footer={
        <Button variant="primary" loading={busy} onClick={save} data-testid="save-as-go">
          Save
        </Button>
      }
    >
      <Field label="File" hint="a .json path on this machine (a folder: <name>.json in it)">
        <TextInput value={path} onChange={setPath} mono data-testid="save-as-path" />
      </Field>
    </Modal>
  );
}

function ImportDialog(
  { open, onClose, onCooked }: {
    open: boolean;
    onClose: () => void;
    onCooked: (a: MeshAsset) => void;
  },
) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [height, setHeight] = useState<number | null>(null);
  const [job, setJob] = useState<api.CookJob | null>(null);
  useEffect(() => {
    if (!job || job.state !== "running") return;
    const timer = setTimeout(() => api.importStatus(job.id).then(setJob), 400);
    return () => clearTimeout(timer);
  }, [job]);
  useEffect(() => {
    if (job?.state === "done" && job.asset) {
      onCooked(job.asset);
      toast({
        title: "Cooked",
        message: `${job.name}: ${job.asset.hulls.length} convex collision pieces`,
        tone: "ok",
      });
    }
  }, [job?.state]);
  const close = () => {
    setJob(null);
    setFile(null);
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={close}
      title="Import a 3D model"
      footer={job?.state === "done"
        ? <Button variant="primary" onClick={close}>Done</Button>
        : (
          <Button
            variant="primary"
            icon="zap"
            disabled={!file || job?.state === "running"}
            loading={job?.state === "running"}
            data-testid="cook"
            onClick={async () => {
              if (!file) return;
              const { job: id } = await api.startImport(
                file,
                name || file.name.replace(/\.[^.]+$/, ""),
                height,
              );
              setJob({ id, name, state: "running", stage: "uploading", progress: 0, log: [] });
            }}
          >
            Cook it
          </Button>
        )}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Text small muted>
          A .glb, .gltf or .obj. Cooking turns it Z-up, sits it on the floor, splits its look by
          color for MuJoCo, and breaks it into convex pieces (CoACD) so the robot collides with its
          real shape.
        </Text>
        <input
          type="file"
          accept=".glb,.gltf,.obj"
          data-testid="import-file"
          onChange={(e) => {
            const chosen = e.target.files?.[0] ?? null;
            setFile(chosen);
            if (chosen && !name) setName(chosen.name.replace(/\.[^.]+$/, ""));
          }}
        />
        <Field label="Name">
          <TextInput value={name} onChange={setName} data-testid="import-name" />
        </Field>
        <Field label="Height" hint="leave empty to keep the model's own size">
          <NumberInput
            nullable
            value={height}
            step={0.1}
            unit="m"
            placeholder="as authored"
            onChange={setHeight}
          />
        </Field>
        {job && (
          <div
            style={{ display: "flex", flexDirection: "column", gap: 6 }}
            data-testid="cook-progress"
          >
            <Progress value={job.progress} />
            <Text small tone={job.state === "failed" ? "danger" : undefined}>{job.stage}</Text>
            {job.state !== "done" && job.log.length > 0 && (
              <CodeBlock code={job.log.slice(-6).join("\n")} language="sh" />
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** reports the world and selection to the backend (GET api/selection) when either changes or this page comes to the front */
function useSelectionReport() {
  useEffect(() => {
    let last = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = (always = false) => {
      // a page in the background (another tab, a hidden Desktop window) isn't the one the user is selecting in
      if (document.visibilityState !== "visible") return;
      const { project, selection } = getState();
      const items = project.items.filter((i) => selection.includes(i.id));
      const sent = JSON.stringify([project.name, selection, items]);
      if (sent === last && !always) return;
      last = sent;
      api.reportSelection(project.name, selection, items).catch(() => {});
    };
    // a drag changes the selected items many times a second: report once it settles
    const unsubscribe = subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(report, 150);
    });
    const front = () => report(true);
    addEventListener("focus", front);
    document.addEventListener("visibilitychange", front);
    report(true);
    return () => {
      unsubscribe();
      clearTimeout(timer);
      removeEventListener("focus", front);
      document.removeEventListener("visibilitychange", front);
    };
  }, []);
}

/** reports this page's view to the backend (GET api/camera) as it moves; one report in flight, the latest wins */
function useCameraReport() {
  useEffect(() => {
    let busy = false;
    let again = false;
    const report = () => {
      if (document.visibilityState !== "visible" || !view.camera) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      const { eye, target, fov } = view.camera.get();
      api.reportCamera(getState().project.name, eye, target, fov).catch(() => {}).finally(() => {
        busy = false;
        if (again) {
          again = false;
          report();
        }
      });
    };
    cameraListeners.add(report);
    addEventListener("focus", report);
    document.addEventListener("visibilitychange", report);
    return () => {
      cameraListeners.delete(report);
      removeEventListener("focus", report);
      document.removeEventListener("visibilitychange", report);
    };
  }, []);
}

/** the world as one GLB (what the editor draws, Z up like the scene), for viewers that want one visual file */
async function bakeVisual(): Promise<ArrayBuffer | null> {
  if (!view.worldRoot) return null;
  // reference photos stay out of the export, as they do out of scene.xml
  const photos: Object3D[] = [];
  view.worldRoot.traverse((o) => {
    if (o.userData.referenceImage && o.visible) photos.push(o);
  });
  photos.forEach((o) => (o.visible = false));
  try {
    const result = await new GLTFExporter().parseAsync(view.worldRoot, {
      binary: true,
      onlyVisible: true,
    });
    return result as ArrayBuffer;
  } finally {
    photos.forEach((o) => (o.visible = true));
  }
}

function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useEditor((s) => s.project);
  const [parent, setParent] = useState("~/dimos_worlds");
  const [listing, setListing] = useState<api.DirListing | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<api.ExportResult | null>(null);
  const packageName = project.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(
    /^_+|_+$/g,
    "",
  );
  useEffect(() => {
    if (open) api.listDirs(parent).then(setListing).catch(() => setListing(null));
  }, [open, parent]);
  const close = () => {
    setResult(null);
    onClose();
  };
  const run = result
    ? `dimos --simulation mujoco --transport zenoh --scene-package ${result.dir} run unitree-go2-freewalk`
    : "";
  return (
    <Modal
      open={open}
      onClose={close}
      title="Export for dimos"
      size="lg"
      footer={result ? <Button variant="primary" onClick={close}>Done</Button> : (
        <Button
          variant="primary"
          icon="download"
          loading={busy}
          data-testid="export-go"
          onClick={async () => {
            setBusy(true);
            try {
              const exported = await api.exportWorld(project, parent);
              const glb = await bakeVisual().catch(() => null);
              if (glb) await api.uploadVisual(exported.dir, glb);
              setResult({
                ...exported,
                files: glb ? [...exported.files, "visual.glb"] : exported.files,
              });
            } catch (error) {
              toast({ title: "Export failed", message: String(error), tone: "danger" });
            } finally {
              setBusy(false);
            }
          }}
        >
          Export {packageName || "world"}
        </Button>
      )}
    >
      {result
        ? (
          <div
            style={{ display: "flex", flexDirection: "column", gap: 10 }}
            data-testid="export-result"
          >
            <Text>
              Wrote <b>{result.dir}</b>: {result.bodies} bodies, {result.movers} moving,{" "}
              {result.files.length} files.
            </Text>
            <Field label="Run a simulated Go2 in it">
              <CodeBlock code={run} language="sh" />
            </Field>
            <Field label="Or from Python">
              <CodeBlock
                language="py"
                code={`import sys; sys.path.insert(0, "${
                  result.dir.replace(/\/[^/]+$/, "")
                }")\nimport ${result.name}\n${result.name}.check()  # compiles scene.xml with MuJoCo`}
              />
            </Field>
            <List divided>
              {result.files.filter((f) => !f.startsWith("meshes/")).map((f) => (
                <ListRow key={f} icon="file" title={f} />
              ))}
              <ListRow
                icon="folder"
                title="meshes/"
                subtitle={`${result.files.filter((f) => f.startsWith("meshes/")).length} files`}
              />
            </List>
          </div>
        )
        : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Field label="Name" hint={`the folder and the Python package: ${packageName}`}>
              <TextInput value={project.name} onChange={renameProject} data-testid="export-name" />
            </Field>
            <Field label="Into the folder">
              <TextInput value={parent} onChange={setParent} mono data-testid="export-parent" />
            </Field>
            {listing && (
              <div
                style={{
                  maxHeight: 220,
                  overflow: "auto",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                }}
              >
                <List divided>
                  <ListRow icon="arrow-up" title=".." onClick={() => setParent(listing.parent)} />
                  {listing.dirs.map((d) => (
                    <ListRow
                      key={d}
                      icon="folder"
                      title={d}
                      onClick={() => setParent(`${listing.path.replace(/\/$/, "")}/${d}`)}
                    />
                  ))}
                </List>
              </div>
            )}
            <Text small muted>
              Writes{" "}
              {packageName}/ with scene.xml (MuJoCo), scene.json (entities, spawns, movers, plus
              views and this project), annotations (the nav test), Python modules and meshes/.
            </Text>
          </div>
        )}
    </Modal>
  );
}

/** viewer mode: how to start a run, and what's on */
function ViewerOverlay() {
  const showCollision = useEditor((s) => s.showCollision);
  const name = useEditor((s) => s.project.name);
  return (
    <div
      style={{
        position: "absolute",
        left: 12,
        top: 12,
        maxWidth: 420,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 10,
        borderRadius: "var(--radius-lg)",
        background: "var(--panel, var(--raised))",
        boxShadow: "var(--shadow)",
      }}
      data-testid="viewer-overlay"
    >
      <Text small>
        Live view of a running simulation of this world: the robot and the moving objects follow the
        blueprint's TF.
      </Text>
      <CodeBlock
        code={`dimos --simulation mujoco --transport zenoh --scene-package ~/dimos_worlds/${name} run unitree-go2-freewalk`}
        language="sh"
      />
      <Toggle
        size="sm"
        value={showCollision}
        onChange={setShowCollision}
        label="Show the robot's lidar"
      />
      <FancyToggle />
    </div>
  );
}

/** right-click on an item: its readable id (renamable), and focus / duplicate / remove */
function ItemMenu() {
  const menu = useMenu();
  const item = useEditor((s) => s.project.items.find((i) => i.id === menu?.itemId) ?? null);
  const selection = useEditor((s) => s.selection);
  const items = useEditor((s) => s.project.items);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setDraft(item?.key ?? "");
    setProblem(null);
  }, [menu?.itemId]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-testid=item-menu]")) openMenu(null);
    };
    addEventListener("pointerdown", close, true);
    return () => removeEventListener("pointerdown", close, true);
  }, [menu]);
  if (!menu || !item) return null;
  const rename = () => {
    const error = renameKey(item.id, draft);
    setProblem(error);
    if (!error) openMenu(null);
  };
  return (
    <div
      data-testid="item-menu"
      style={{
        position: "fixed",
        left: Math.min(menu.x, innerWidth - 260),
        top: Math.min(menu.y, innerHeight - 220),
        width: 240,
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 10,
        borderRadius: "var(--radius-lg)",
        background: "var(--raised)",
        border: "1px solid var(--border)",
        boxShadow: "var(--shadow-lg)",
      }}
    >
      <Text small muted>
        {selection.length > 1 ? `${selection.length} items selected` : item.name}
      </Text>
      {(selection.length > 1 || item.group) && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {selection.length > 1 && !selection.every((id) => {
            const member = items.find((i) =>
              i.id === id
            );
            return member?.group && member.group === item.group;
          }) && (
            <Button
              size="sm"
              icon="layers"
              variant="primary"
              data-testid="menu-group"
              onClick={() => (groupSelection(), openMenu(null))}
            >
              Group
            </Button>
          )}
          {item.group && (
            <Button
              size="sm"
              icon="layers"
              data-testid="menu-ungroup"
              onClick={() => (ungroup(item.group!), openMenu(null))}
            >
              Ungroup
            </Button>
          )}
        </div>
      )}
      <Field label="Id (the entity name in the exported scene)">
        <TextInput
          value={draft}
          onChange={setDraft}
          onEnter={rename}
          mono
          autoFocus
          data-testid="item-key"
          invalid={Boolean(problem)}
        />
      </Field>
      {problem && <Text small tone="danger">{problem}</Text>}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Button size="sm" variant="primary" onClick={rename}>Rename</Button>
        <Button
          size="sm"
          icon="target"
          onClick={() => {
            (globalThis as unknown as { dimWorldBuilder: { focus(k: string): void } })
              .dimWorldBuilder.focus(
                item.key ?? "",
              );
            openMenu(null);
          }}
        >
          Focus
        </Button>
        <Button size="sm" icon="copy" onClick={() => (duplicateItem(item.id), openMenu(null))}>
          Duplicate
        </Button>
        <Button
          size="sm"
          icon="trash"
          variant="danger"
          onClick={() => (removeItem(item.id), openMenu(null))}
        >
          Remove
        </Button>
      </div>
    </div>
  );
}

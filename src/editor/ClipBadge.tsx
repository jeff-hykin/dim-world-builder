// The top bar's clip warning: a moment after each edit the backend checks every pair of collision shapes (MuJoCo) and
// this lists the pairs that interpenetrate: problems (furniture into furniture, or deep into a wall) in red; the expected
// ones (walls meeting walls, things standing against them) only behind "show expected". Clicking one selects the pair
// and glides the camera to the spot.
import { useEffect, useRef, useState } from "react";
import * as api from "../api.ts";
import { Button } from "../ui.ts";
import { keyedProject } from "../world/keys.ts";
import type { Vec3 } from "../world/types.ts";
import { view } from "./palette.ts";
import { getState, select, useEditor } from "./store.ts";

/** wait this long after the last edit before checking */
const CHECK_AFTER_MS = 2500;

export function ClipBadge() {
  const project = useEditor((s) => s.project);
  const [clips, setClips] = useState<api.Clip[]>([]);
  const [open, setOpen] = useState(false);
  const [showExpected, setShowExpected] = useState(false);
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      api.checkClips(project).then((report) => current && setClips(report.clips)).catch(() => {});
    }, CHECK_AFTER_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [project]);
  const anchor = useRef<HTMLDivElement>(null);
  const problems = clips.filter((c) => c.severity === "problem");
  if (!problems.length && !open) return null;
  const listed = showExpected ? clips : problems;
  const show = (clip: api.Clip) => {
    const items = keyedProject(getState().project).items;
    const [a, b] = [clip.a, clip.b].map((s) => items.find((i) => i.key === s.key));
    select(a?.id ?? b?.id ?? null);
    if (a && b) select(b.id, { add: true, member: true });
    const camera = view.camera?.get();
    if (camera) {
      // keep looking from the same side, 4 m from the spot
      const away = camera.eye.map((v, i) => v - camera.target[i]);
      const length = Math.hypot(...away) || 1;
      const eye = clip.at.map((v, i) => v + (away[i] / length) * 4) as Vec3;
      view.camera?.goTo(eye, clip.at);
    }
    setOpen(false);
  };
  return (
    <div ref={anchor} style={{ position: "relative" }}>
      <Button
        size="sm"
        variant={problems.length ? "danger" : "ghost"}
        icon="alert"
        onClick={() => setOpen(!open)}
        data-testid="clip-badge"
        title="items passing into each other (walls and floors meeting is expected and not counted)"
      >
        {problems.length} clipping
      </Button>
      {open && (
        <div
          data-testid="clip-list"
          style={{
            // fixed to the window, not the badge: on a phone the badge sits mid-bar and a badge-anchored list ran off the left edge
            position: "fixed",
            right: 8,
            top: (anchor.current?.getBoundingClientRect().bottom ?? 48) + 6,
            zIndex: 20,
            width: "min(360px, calc(100vw - 16px))",
            maxHeight: 320,
            overflow: "auto",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: 4,
          }}
        >
          <label
            style={{ display: "flex", gap: 6, padding: "4px 8px", color: "var(--muted-fg)" }}
          >
            <input
              type="checkbox"
              checked={showExpected}
              onChange={(e) => setShowExpected(e.currentTarget.checked)}
              data-testid="clip-show-expected"
            />
            show expected ({clips.length - problems.length}: walls, floors and things against them)
          </label>
          {listed.map((clip) => (
            <button
              type="button"
              key={`${clip.a.key}/${clip.b.key}`}
              onClick={() => show(clip)}
              data-testid={`clip-${clip.a.key}-${clip.b.key}`}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "6px 8px",
                background: "transparent",
                border: 0,
                color: clip.severity === "problem" ? "var(--danger)" : "var(--muted-fg)",
                cursor: "pointer",
                font: "inherit",
              }}
            >
              {clip.a.name} <span style={{ color: "var(--muted-fg)" }}>({clip.a.key})</span> ↔{" "}
              {clip.b.name} <span style={{ color: "var(--muted-fg)" }}>({clip.b.key})</span> ·{" "}
              {Math.round(clip.depth_m * 100)} cm
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

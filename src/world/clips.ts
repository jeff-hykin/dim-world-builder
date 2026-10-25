// Which clips matter: structure (walls, floors, columns, doors, stairs...) is built to meet and overlap, so those clips
// are expected; furniture and objects passing into each other, or deep into a wall, are problems.

import { keyedProject } from "./keys.ts";
import type { Item, Project, Vec3 } from "./types.ts";

/** one clip as cooker/check_clips.py reports it (a, b by body name = item key) */
export interface RawClip {
  a: { key: string; name: string; kind: string | null };
  b: { key: string; name: string; kind: string | null };
  depth_m: number;
  at: Vec3;
}

export interface ClipSide {
  id: string | null;
  key: string;
  name: string;
  kind: string | null;
  structure: boolean;
}

export interface Clip {
  severity: "problem" | "expected";
  a: ClipSide;
  b: ClipSide;
  depth_m: number;
  at: Vec3;
  message: string;
}

/** furniture this far into a wall or floor still counts as standing against it (modeling slop), meters */
export const TOUCHING_M = 0.05;

const STRUCTURE_KINDS = new Set(["room", "stairs", "hole", "hill", "slab"]);
const STRUCTURE_WORDS =
  /\b(walls?|floors?|ceilings?|slabs?|columns?|pillars?|posts?|beams?|truss|braces?|chords?|purlins?|joists?|rafters?|skylights?|mullions?|curbs?|doors?|doorways?|windows?|lintels?|sills?|glass|stairs?|stairwells?|rails?|railings?|roofs?|parapets?|partitions?|ramps?)\b/i;

/** walls, floors, columns, doors, windows, stairs, rooms, holes: by its `structure` flag, kind, a box's name or a model's asset */
export function isStructure(item: Item | undefined, kind: string | null = null): boolean {
  if (item?.structure !== undefined) return item.structure;
  if (STRUCTURE_KINDS.has(item?.kind ?? kind ?? "")) return true;
  // a model is what its asset is (a doorway, a fence), whatever it's named; a plain box is what it's named
  if (item?.kind === "mesh") return STRUCTURE_WORDS.test(item.params.asset.replace(/_/g, " "));
  if (item?.kind !== "primitive") return false;
  return STRUCTURE_WORDS.test(item.name.replace(/_/g, " "));
}

/** each clip with its severity and a one-line message */
export function classifyClips(project: Project, raw: RawClip[]): Clip[] {
  const byKey = new Map(keyedProject(project).items.map((i) => [i.key, i]));
  const side = (s: RawClip["a"]): ClipSide => {
    const item = byKey.get(s.key);
    return {
      id: item?.id ?? null,
      key: s.key,
      name: s.name,
      kind: s.kind,
      structure: isStructure(item, s.kind),
    };
  };
  return raw.map((clip) => {
    const a = side(clip.a), b = side(clip.b);
    const cm = Math.round(clip.depth_m * 100);
    const named = (s: ClipSide) => `${s.name} (${s.key})`;
    let severity: Clip["severity"];
    let message: string;
    if (a.structure && b.structure) {
      severity = "expected";
      message = `ok: ${named(a)} meets ${named(b)} (structure meeting structure is expected)`;
    } else if (a.structure || b.structure) {
      const [thing, wall] = a.structure ? [b, a] : [a, b];
      severity = clip.depth_m <= TOUCHING_M ? "expected" : "problem";
      message = severity === "expected"
        ? `ok: ${named(thing)} stands against ${named(wall)} (${cm} cm, touching is expected)`
        : `PROBLEM: ${named(thing)} goes ${cm} cm into ${named(wall)}: move it out`;
    } else {
      severity = "problem";
      message = `PROBLEM: ${named(a)} clips into ${named(b)} by ${cm} cm: move one`;
    }
    return {
      severity,
      a,
      b,
      depth_m: clip.depth_m,
      at: clip.at,
      message: `${message} at [${clip.at.join(", ")}]`,
    };
  }).sort((
    x,
    y,
  ) => (x.severity === y.severity ? y.depth_m - x.depth_m : x.severity === "problem" ? -1 : 1));
}

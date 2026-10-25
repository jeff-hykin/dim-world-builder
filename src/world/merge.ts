// Merging a page's save into a world that changed since the page loaded it (an agent's edit through the API).

import type { Project } from "./types.ts";

/** JSON with sorted keys, to compare values whatever order their fields were written in */
function canonical(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
        : v,
  );
}

/**
 * The world as it is now with the page's edits on top: an item the page changed, added or removed (compared with the
 * version it loaded) is taken from the page; every other item, and other changes made since, stay as they are now
 */
export function mergeEdits(base: Project, page: Project, current: Project): Project {
  const baseItems = new Map(base.items.map((i) => [i.id, i]));
  const pageItems = new Map(page.items.map((i) => [i.id, i]));
  const touched = new Set(
    page.items.filter((i) => canonical(i) !== canonical(baseItems.get(i.id))).map((i) => i.id),
  );
  const removed = new Set(base.items.filter((i) => !pageItems.has(i.id)).map((i) => i.id));
  const items = current.items.filter((i) => !removed.has(i.id)).map((i) =>
    touched.has(i.id) ? pageItems.get(i.id)! : i
  );
  const have = new Set(items.map((i) => i.id));
  // the page's new items (and items it changed that are gone now: its edit brings them back)
  for (const item of page.items) {
    if (touched.has(item.id) && !have.has(item.id)) items.push(item);
  }
  const merged: Record<string, unknown> = { ...current };
  const keys = new Set([...Object.keys(page), ...Object.keys(base)]);
  for (const key of keys) {
    if (key === "items") continue;
    const ofPage = (page as unknown as Record<string, unknown>)[key];
    if (canonical(ofPage) !== canonical((base as unknown as Record<string, unknown>)[key])) {
      merged[key] = ofPage;
    }
  }
  return { ...(merged as unknown as Project), items };
}

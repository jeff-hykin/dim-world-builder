import { expect, test } from "vitest";
import { emptyProject, makeItem } from "../world/defaults.ts";
import { addFloor, copyName, getState, loadProject } from "./store.ts";

test("a new floor comes with a slab over what's on the floor below, so what's added to it stands on something", () => {
  const project = emptyProject("t");
  project.items.push(
    makeItem("primitive", { shape: "box", color: [1, 1, 1] }, {
      name: "a",
      floor: "ground",
      position: [0, 0, 0],
    }),
    makeItem("primitive", { shape: "box", color: [1, 1, 1] }, {
      name: "b",
      floor: "ground",
      position: [10, 4, 0],
    }),
  );
  loadProject(project);
  addFloor();
  const floor = getState().project.floors.at(-1)!;
  expect(getState().project.activeFloor).toBe(floor.id);
  expect(floor.elevation).toBe(3);
  expect(floor.slab).toMatchObject({ sizeX: 13, sizeY: 7, center: [5, 2] });
});

test("copies are numbered instead of stacking ' copy'", () => {
  expect(copyName("Desk", ["Desk"])).toBe("Desk copy1");
  expect(copyName("Desk copy1", ["Desk", "Desk copy1"])).toBe("Desk copy2");
  expect(copyName("Desk copy copy copy", ["Desk"])).toBe("Desk copy1");
});

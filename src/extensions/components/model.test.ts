import { describe, expect, it } from "vitest";
import type { El } from "../reactor/reactor";
import {
  COMPONENT_NS,
  componentDeps,
  dependsOn,
  readTags,
  topoOrder,
  type ComponentTag,
  withTag,
  withoutTag,
} from "./model";

const el = (customData?: Record<string, unknown>) => ({ id: "e", customData }) as unknown as El;
const tag = (componentId: string, gi: number, extra: Partial<ComponentTag> = {}): ComponentTag => ({
  v: 1,
  role: "instance",
  componentId,
  slot: "s",
  gi,
  ...extra,
});

describe("component tag model", () => {
  it("writes a plain single tag as v1 so older builds can read it", () => {
    const data = withTag(el(), tag("A", 0, { source: "library", libraryId: "A" }));
    expect(data[COMPONENT_NS]).toMatchObject({ v: 1, componentId: "A", source: "library" });
    expect(readTags(el(data))).toEqual([expect.objectContaining({ componentId: "A" })]);
  });

  it("writes v2 only when a v2-only field is used", () => {
    const data = withTag(el(), tag("A", 0, { pv: { p: "x" } }));
    expect((data[COMPONENT_NS] as ComponentTag).v).toBe(2);
    const hidden = withTag(el(), tag("A", 0, { overrides: { visible: false } }));
    expect((hidden[COMPONENT_NS] as ComponentTag).v).toBe(2);
  });

  it("stores several tags inner → outer and removes one at a time", () => {
    let data = withTag(el(), tag("B", 1, { role: "master" }));
    data = withTag(el(data), tag("A", 0));
    expect(data[COMPONENT_NS]).toMatchObject({
      v: 2,
      tags: [{ componentId: "A" }, { componentId: "B" }],
    });
    expect(readTags(el(data))!.map((t) => t.componentId)).toEqual(["A", "B"]);
    const rest = withoutTag(el(data), "A");
    expect(rest[COMPONENT_NS]).toMatchObject({ componentId: "B", role: "master" });
    expect(COMPONENT_NS in withoutTag(el(rest), "B")).toBe(false);
  });

  it("reports unreadable data as null so it is left alone", () => {
    expect(readTags(el({ [COMPONENT_NS]: { v: 9, role: "master" } }))).toBeNull();
    expect(readTags(el({ [COMPONENT_NS]: { v: 3, tags: [] } }))).toBeNull();
    expect(readTags(el())).toEqual([]);
  });

  it("builds the nesting graph, detects cycles and orders inner first", () => {
    const e = el(withTag(el(withTag(el(), tag("B", 1, { role: "master" }))), tag("A", 0)));
    const deps = componentDeps([e]);
    expect(dependsOn(deps, "B", "A")).toBe(true);
    expect(dependsOn(deps, "A", "B")).toBe(false);
    expect(topoOrder(["B", "A"], deps)).toEqual(["A", "B"]);
  });
});

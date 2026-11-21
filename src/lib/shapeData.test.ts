import { describe, expect, it } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import {
  customDataWith,
  DATA_KEY,
  dataTargets,
  normaliseKey,
  normaliseValue,
  patchEntries,
  readData,
  sharedData,
  toCsv,
  type DataEntry,
} from "./shapeData";

const withData = (entries: unknown, extra: Record<string, unknown> = {}) =>
  ({ customData: { ...extra, [DATA_KEY]: { v: 1, entries } } }) as Pick<
    ExcalidrawElement,
    "customData"
  >;

describe("shapeData", () => {
  it("reads v1 data and treats unknown versions as read-only", () => {
    expect(readData({ customData: undefined })).toEqual({ entries: [], readOnly: false });
    expect(readData(withData([["a", "1"]]))).toEqual({ entries: [["a", "1"]], readOnly: false });
    expect(readData({ customData: { [DATA_KEY]: { v: 2, entries: [["a", "1"]] } } })).toEqual({
      entries: [["a", "1"]],
      readOnly: true,
    });
    expect(readData({ customData: { [DATA_KEY]: "junk" } }).readOnly).toBe(true);
    expect(() => customDataWith({ customData: { [DATA_KEY]: { v: 2 } } }, [])).toThrow(/newer/);
  });

  it("patches in place, appends, removes and replaces", () => {
    const base: DataEntry[] = [
      ["a", "1"],
      ["b", "2"],
    ];
    expect(patchEntries(base, { b: "x", c: "3", a: null })).toEqual([
      ["b", "x"],
      ["c", "3"],
    ]);
    expect(patchEntries(base, { c: "3" }, true)).toEqual([["c", "3"]]);
  });

  it("stores entries next to other customData and drops the key when empty", () => {
    const el = withData([["a", "1"]], { excalidrawDesktop: { chain: [] } });
    expect(customDataWith(el, [["a", "1"]])).toBe(el.customData);
    expect(customDataWith(el, [["a", "2"]])).toEqual({
      excalidrawDesktop: { chain: [] },
      [DATA_KEY]: { v: 1, entries: [["a", "2"]] },
    });
    expect(customDataWith(el, [])).toEqual({ excalidrawDesktop: { chain: [] } });
    expect(customDataWith(withData([["a", "1"]]), [])).toEqual({});
  });

  it("validates keys and values", () => {
    expect(normaliseKey("  owner ")).toBe("owner");
    expect(() => normaliseKey(" ")).toThrow(/empty/);
    expect(normaliseValue(3)).toBe("3");
    expect(normaliseValue(false)).toBe("false");
    expect(() => normaliseValue({})).toThrow(/strings/);
  });

  it("shows shared keys of a mixed selection, with Mixed values", () => {
    const view = sharedData([
      withData([
        ["owner", "ann"],
        ["cost", "3"],
        ["only", "x"],
      ]),
      withData([
        ["cost", "4"],
        ["owner", "ann"],
      ]),
    ]);
    expect(view).toEqual({
      rows: [
        { key: "owner", value: "ann" },
        { key: "cost", value: null },
      ],
      partial: 1,
      readOnly: false,
    });
  });

  it("targets containers instead of their selected labels", () => {
    const els = [
      { id: "r", type: "rectangle", isDeleted: false },
      { id: "t", type: "text", isDeleted: false, containerId: "r" },
      { id: "u", type: "text", isDeleted: false, containerId: "other" },
    ];
    expect(dataTargets(els as unknown as ExcalidrawElement[]).map((e) => e.id)).toEqual(["r", "u"]);
  });

  it("writes CSV with the union of keys, quoting and formula guards", () => {
    const csv = toCsv([
      { id: "a", type: "rectangle", label: "Hello, world", data: [["k", 'say "hi"']] },
      {
        id: "b",
        type: "text",
        data: [
          ["n", "-5"],
          ["f", "=SUM(A1)"],
        ],
      },
    ]);
    expect(csv).toBe(
      'id,type,label,k,n,f\r\na,rectangle,"Hello, world","say ""hi""",,\r\nb,text,,,-5,\'=SUM(A1)\r\n',
    );
  });
});

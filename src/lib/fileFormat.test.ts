import { describe, it, expect } from "vitest";
import { detectFormat, isExcalidrawFile, serializeScene } from "./fileFormat";

describe("detectFormat", () => {
  it("recognizes a valid excalidraw JSON document", () => {
    const json = JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "excalidraw-desktop",
      elements: [{ id: "a" }],
      appState: {},
      files: {},
    });
    const result = detectFormat(json);
    expect(result.kind).toBe("excalidraw-json");
    expect(result.parsed?.elements).toHaveLength(1);
  });

  it("tolerates leading whitespace before the JSON object", () => {
    const json = `\n  ${JSON.stringify({ type: "excalidraw", version: 2, elements: [] })}\n`;
    expect(detectFormat(json).kind).toBe("excalidraw-json");
  });

  it("returns unknown for non-JSON input", () => {
    const result = detectFormat("hello world");
    expect(result.kind).toBe("unknown");
    expect(result.reason).toMatch(/not a JSON object/);
  });

  it("returns unknown for invalid JSON", () => {
    const result = detectFormat("{not valid json");
    expect(result.kind).toBe("unknown");
    expect(result.reason).toMatch(/invalid JSON/);
  });

  it("returns unknown when the discriminator is missing", () => {
    const json = JSON.stringify({ version: 2, elements: [] });
    const result = detectFormat(json);
    expect(result.kind).toBe("unknown");
    expect(result.reason).toMatch(/discriminator/);
  });

  it("rejects an object whose elements field is not an array", () => {
    const json = JSON.stringify({ type: "excalidraw", version: 2, elements: "nope" });
    expect(detectFormat(json).kind).toBe("unknown");
  });
});

describe("isExcalidrawFile", () => {
  it("rejects null and primitives", () => {
    expect(isExcalidrawFile(null)).toBe(false);
    expect(isExcalidrawFile(42)).toBe(false);
    expect(isExcalidrawFile("excalidraw")).toBe(false);
  });
});

describe("serializeScene", () => {
  it("produces a roundtrip-parseable document", () => {
    const out = serializeScene([{ id: "x" }], { viewBackgroundColor: "#fff" }, {});
    const detected = detectFormat(out);
    expect(detected.kind).toBe("excalidraw-json");
    expect(detected.parsed?.elements).toHaveLength(1);
    expect(detected.parsed?.appState?.viewBackgroundColor).toBe("#fff");
  });

  it("sets a source identifier so downstream tooling can attribute the file", () => {
    const out = serializeScene([], {}, {});
    const detected = detectFormat(out);
    expect(detected.parsed?.source).toBe("excalidraw-desktop");
  });
});

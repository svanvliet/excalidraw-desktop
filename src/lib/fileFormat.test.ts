import { describe, it, expect } from "vitest";
import {
  detectFormat,
  isExcalidrawFile,
  serializeScene,
  looksLikePng,
  base64ToBytes,
  bytesToBase64,
  formatFromExtension,
} from "./fileFormat";

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

describe("looksLikePng", () => {
  it("recognizes the canonical PNG signature", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]);
    expect(looksLikePng(bytes)).toBe(true);
  });

  it("rejects content that is too short", () => {
    expect(looksLikePng(new Uint8Array([0x89, 0x50]))).toBe(false);
  });

  it("rejects content with the wrong magic", () => {
    const bytes = new Uint8Array([0x00, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(looksLikePng(bytes)).toBe(false);
  });
});

describe("base64ToBytes / bytesToBase64", () => {
  it("roundtrips a small binary payload", () => {
    const original = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x42]);
    const b64 = bytesToBase64(original);
    const back = base64ToBytes(b64);
    expect(Array.from(back)).toEqual(Array.from(original));
  });

  it("roundtrips a buffer larger than the chunk size", () => {
    const original = new Uint8Array(0x9000);
    for (let i = 0; i < original.length; i++) original[i] = i & 0xff;
    const back = base64ToBytes(bytesToBase64(original));
    expect(back.length).toBe(original.length);
    expect(back[0]).toBe(0);
    expect(back[0x9000 - 1]).toBe((0x9000 - 1) & 0xff);
  });
});

describe("formatFromExtension", () => {
  it("recognizes .png (case-insensitively)", () => {
    expect(formatFromExtension("/tmp/foo.png")).toBe("png");
    expect(formatFromExtension("/tmp/foo.PNG")).toBe("png");
  });

  it("defaults to json for everything else", () => {
    expect(formatFromExtension("/tmp/foo.excalidraw")).toBe("json");
    expect(formatFromExtension("/tmp/foo")).toBe("json");
  });
});

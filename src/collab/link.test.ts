import { describe, expect, it } from "vitest";
import { buildShareLink, generateRoomId, isValidRoomId, parseShareLink, wsUrlFor } from "./link";

const KEY = "AAAAAAAAAAAAAAAAAAAAAA";
const ROOM = "0123456789abcdef0123";

describe("collab share links", () => {
  it("generates 20-hex room ids", () => {
    const id = generateRoomId();
    expect(isValidRoomId(id)).toBe(true);
    expect(generateRoomId()).not.toBe(id);
  });

  it("builds and parses a link, stripping trailing slashes", () => {
    const link = buildShareLink("https://abc-4780.usw3.devtunnels.ms/", ROOM, KEY);
    expect(link).toBe(`https://abc-4780.usw3.devtunnels.ms/#room=${ROOM},${KEY}`);
    expect(parseShareLink(link)).toEqual({
      publicBase: "https://abc-4780.usw3.devtunnels.ms",
      roomId: ROOM,
      key: KEY,
    });
  });

  it("parses a bare hash using the fallback base", () => {
    expect(parseShareLink(`#room=${ROOM},${KEY}`, "http://127.0.0.1:4780")).toEqual({
      publicBase: "http://127.0.0.1:4780",
      roomId: ROOM,
      key: KEY,
    });
  });

  it("returns null for malformed links", () => {
    expect(parseShareLink("https://x.test/")).toBeNull();
    expect(parseShareLink(`#room=${ROOM.toUpperCase()},${KEY}`)).toBeNull();
    expect(parseShareLink(`#room=${ROOM},short`)).toBeNull();
    expect(parseShareLink(`#room=${ROOM}`)).toBeNull();
  });

  it("derives ws urls", () => {
    expect(wsUrlFor("http://127.0.0.1:4780")).toBe("ws://127.0.0.1:4780/ws");
    expect(wsUrlFor("https://abc.devtunnels.ms/")).toBe("wss://abc.devtunnels.ms/ws");
    expect(() => wsUrlFor("ftp://x")).toThrow();
  });
});

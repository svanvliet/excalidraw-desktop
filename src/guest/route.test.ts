import { describe, expect, it } from "vitest";
import { guestLinkFor } from "./route";

const HREF = "https://draw.example.com/collab/#room=0123456789abcdef0123,AAAAAAAAAAAAAAAAAAAAAA";

describe("guestLinkFor", () => {
  it("parses a share link in a plain browser", () => {
    expect(guestLinkFor(HREF, false)).toEqual({
      publicBase: "https://draw.example.com/collab",
      roomId: "0123456789abcdef0123",
      key: "AAAAAAAAAAAAAAAAAAAAAA",
    });
  });

  it("never activates inside Tauri", () => {
    expect(guestLinkFor(HREF, true)).toBeNull();
  });

  it("ignores pages without a valid room fragment", () => {
    expect(guestLinkFor("https://draw.example.com/", false)).toBeNull();
    expect(guestLinkFor("https://draw.example.com/#room=nope", false)).toBeNull();
  });
});

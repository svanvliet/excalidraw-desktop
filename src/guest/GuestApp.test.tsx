import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UseCollabSessionOptions, UseCollabSessionResult } from "../collab/useCollabSession";

vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: (p: { renderTopRightUI?: () => unknown }) => (
    <div data-testid="excalidraw-mock">{p.renderTopRightUI?.() as never}</div>
  ),
  LiveCollaborationTrigger: (p: { title?: string; onSelect: () => void }) => (
    <button data-testid="collab-trigger" title={p.title} onClick={p.onSelect} />
  ),
}));
vi.mock("@excalidraw/excalidraw/index.css", () => ({}));

const hook = vi.hoisted(() => ({
  calls: [] as UseCollabSessionOptions[],
  result: {} as Partial<UseCollabSessionResult>,
}));
vi.mock("../collab/useCollabSession", () => ({
  useCollabSession: (opts: UseCollabSessionOptions) => {
    hook.calls.push(opts);
    return {
      status: "connected",
      error: null,
      peers: [],
      handlers: { onChange: () => {}, onPointerUpdate: () => {} },
      session: null,
      ...hook.result,
    };
  },
}));

import { GUEST_NAME_KEY, GuestApp } from "./GuestApp";

const LINK = {
  publicBase: "http://127.0.0.1:4780",
  roomId: "0123456789abcdef0123",
  key: "AAAAAAAAAAAAAAAAAAAAAA",
};
const lastCall = () => hook.calls[hook.calls.length - 1];

beforeEach(() => {
  localStorage.clear();
  hook.calls = [];
  hook.result = {};
});

describe("GuestApp", () => {
  it("asks for a name before joining and remembers it", () => {
    render(<GuestApp link={LINK} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(lastCall().link).toBeNull();

    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "  Ada  " } });
    fireEvent.click(screen.getByRole("button", { name: "Join" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(localStorage.getItem(GUEST_NAME_KEY)).toBe("Ada");
    expect(lastCall()).toMatchObject({ link: LINK, username: "Ada", isHost: false });
  });

  it("skips the prompt for returning guests and shows peer count", () => {
    localStorage.setItem(GUEST_NAME_KEY, "Bob");
    hook.result = {
      peers: [{ clientId: "x", username: "Ann", isHost: true, userState: "active" }],
    };
    render(<GuestApp link={LINK} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(lastCall().link).toEqual(LINK);
    expect(screen.getByTestId("collab-trigger").title).toMatch(/^2 in session/);
  });

  it("Escape on the prompt falls back to a default name", () => {
    render(<GuestApp link={LINK} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(lastCall().username).toBe("Guest");
  });

  it.each([
    ["reconnecting", /reconnecting/],
    ["ended", /host ended/],
  ] as const)("shows a banner when %s", (status, text) => {
    localStorage.setItem(GUEST_NAME_KEY, "Bob");
    hook.result = { status };
    render(<GuestApp link={LINK} />);
    expect(screen.getByRole("status").textContent).toMatch(text);
  });

  it("shows no banner once connected", () => {
    localStorage.setItem(GUEST_NAME_KEY, "Bob");
    render(<GuestApp link={LINK} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

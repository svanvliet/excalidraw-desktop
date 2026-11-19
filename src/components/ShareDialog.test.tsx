import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { CollabStartArgs, CollabStatus } from "../ipc/commands";

const ipc = vi.hoisted(() => ({
  collabStart: vi.fn<(args: CollabStartArgs) => Promise<CollabStatus>>(),
  collabStop: vi.fn<() => Promise<CollabStatus>>(),
  collabRemovePeer: vi.fn<(id: string) => Promise<void>>(),
}));
vi.mock("../ipc/commands", async (orig) => {
  const actual = await orig<typeof import("../ipc/commands")>();
  return {
    ...actual,
    collabStart: (a: CollabStartArgs) => ipc.collabStart(a),
    collabStop: () => ipc.collabStop(),
    collabRemovePeer: (id: string) => ipc.collabRemovePeer(id),
  };
});

import { COLLAB_STATUS_OFF } from "../ipc/commands";
import { ShareDialog } from "./ShareDialog";
import { useCollabStore, __resetCollabStoreForTests } from "../stores/collabStore";
import { useSettingsStore, __resetSettingsForTests } from "../stores/settingsStore";

function status(over: Partial<CollabStatus> = {}): CollabStatus {
  return {
    running: true,
    roomId: "0123456789abcdef0123",
    localPort: 4780,
    localBase: "http://127.0.0.1:4780",
    hostToken: null,
    publicBase: null,
    tunnel: { mode: "auto", state: "starting", error: null },
    peerCount: 1,
    ...over,
  };
}

function hostSession(over: Partial<CollabStatus> = {}) {
  const s = status(over);
  useCollabStore.setState({
    status: s,
    session: {
      role: "host",
      tabId: "t1",
      roomId: "0123456789abcdef0123",
      key: "AAAAAAAAAAAAAAAAAAAAAA",
      publicBase: s.publicBase,
    },
  });
}

function renderDialog(props: Partial<Parameters<typeof ShareDialog>[0]> = {}) {
  const p = { open: true, onClose: vi.fn(), tabId: "t1", onOpenSettings: vi.fn(), ...props };
  render(<ShareDialog {...p} />);
  return p;
}

describe("ShareDialog", () => {
  beforeEach(() => {
    __resetCollabStoreForTests();
    __resetSettingsForTests();
    ipc.collabStart.mockReset();
    ipc.collabStop.mockReset().mockResolvedValue(COLLAB_STATUS_OFF);
  });

  it("with collab off, explains and routes to Settings without starting anything", () => {
    const p = renderDialog();
    expect(screen.getByTestId("share-disabled")).toBeInTheDocument();
    expect(screen.queryByTestId("share-start")).toBeNull();
    fireEvent.click(screen.getByTestId("share-open-settings"));
    expect(p.onClose).toHaveBeenCalled();
    expect(p.onOpenSettings).toHaveBeenCalled();
    expect(ipc.collabStart).not.toHaveBeenCalled();
  });

  it("Start session calls collab_start for the active tab", async () => {
    useSettingsStore.setState({ collab: true });
    ipc.collabStart.mockImplementation(async (a) => status({ roomId: a.roomId }));
    renderDialog();
    fireEvent.click(screen.getByTestId("share-start"));
    await waitFor(() => expect(screen.getByTestId("share-status")).toBeInTheDocument());
    expect(ipc.collabStart).toHaveBeenCalledTimes(1);
    expect(useCollabStore.getState().session?.tabId).toBe("t1");
  });

  it("blocks Start in manual mode without a URL", () => {
    useSettingsStore.setState({ collab: true, collabTunnelMode: "manual", collabManualUrl: "" });
    renderDialog();
    expect(screen.getByTestId("share-start")).toBeDisabled();
  });

  it("shows the share link, local link, peer count, and copies to clipboard", async () => {
    useSettingsStore.setState({ collab: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    hostSession({
      publicBase: "https://abc-4780.usw3.devtunnels.ms",
      tunnel: { mode: "auto", state: "ready", error: null },
      peerCount: 3,
    });
    renderDialog({
      peers: [
        {
          clientId: "a",
          username: "Ann",
          isHost: false,
          role: "editor",
          requestedEdit: false,
          userState: "active",
        },
        {
          clientId: "b",
          username: "Bob",
          isHost: false,
          role: "editor",
          requestedEdit: false,
          userState: "idle",
        },
      ],
    });
    const link = screen.getByTestId<HTMLInputElement>("share-link");
    expect(link.value).toBe(
      "https://abc-4780.usw3.devtunnels.ms/#room=0123456789abcdef0123,AAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(screen.getByTestId<HTMLInputElement>("share-local-link").value).toBe(
      "http://127.0.0.1:4780/#room=0123456789abcdef0123,AAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(screen.getByTestId("share-peer-count")).toHaveTextContent("3");
    fireEvent.click(screen.getByTestId("share-link-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(link.value));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("lists participants and removes one via collab_remove_peer", async () => {
    useSettingsStore.setState({ collab: true });
    ipc.collabRemovePeer.mockResolvedValue(undefined);
    hostSession({ tunnel: { mode: "auto", state: "ready", error: null } });
    renderDialog({
      selfName: "Scott",
      peers: [
        {
          clientId: "c1",
          username: "Ann",
          isHost: false,
          role: "editor",
          requestedEdit: false,
          userState: "active",
        },
      ],
    });
    expect(screen.getByTestId("participants")).toHaveTextContent(/Scott.*you · host.*Ann/);
    fireEvent.click(screen.getByRole("button", { name: "Remove Ann" }));
    await waitFor(() => expect(ipc.collabRemovePeer).toHaveBeenCalledWith("c1"));
  });

  it.each([
    ["devtunnel_not_installed", "brew install --cask devtunnel"],
    ["devtunnel_not_logged_in", "devtunnel user login"],
    ["devtunnel_failed: port taken", "port taken"],
  ])("shows actionable help for %s", (error, expected) => {
    useSettingsStore.setState({ collab: true });
    hostSession({ tunnel: { mode: "auto", state: "error", error } });
    renderDialog();
    expect(screen.getByTestId("share-tunnel-error")).toHaveTextContent(expected);
    expect(screen.queryByTestId("share-link")).toBeNull();
    // Local link still offered as a fallback.
    expect(screen.getByTestId("share-local-link")).toBeInTheDocument();
  });

  it("Stop session calls collab_stop", async () => {
    useSettingsStore.setState({ collab: true });
    hostSession();
    renderDialog();
    fireEvent.click(screen.getByTestId("share-stop"));
    await waitFor(() => expect(ipc.collabStop).toHaveBeenCalledTimes(1));
    expect(useCollabStore.getState().session).toBeNull();
  });

  it("Escape and backdrop close; dialog body does not", () => {
    const p = renderDialog();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(p.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Live collaboration"));
    expect(p.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("share-backdrop"));
    expect(p.onClose).toHaveBeenCalledTimes(2);
  });
});

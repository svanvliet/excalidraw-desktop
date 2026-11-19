import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CollabStartArgs, CollabStatus } from "../ipc/commands";

const ipc = vi.hoisted(() => ({
  collabStart: vi.fn<(args: CollabStartArgs) => Promise<CollabStatus>>(),
  collabStop: vi.fn<() => Promise<CollabStatus>>(),
  collabStatus: vi.fn<() => Promise<CollabStatus>>(),
  statusHandler: null as ((s: CollabStatus) => void) | null,
}));

vi.mock("../ipc/commands", async (orig) => {
  const actual = await orig<typeof import("../ipc/commands")>();
  return {
    ...actual,
    collabStart: (a: CollabStartArgs) => ipc.collabStart(a),
    collabStop: () => ipc.collabStop(),
    collabStatus: () => ipc.collabStatus(),
  };
});
vi.mock("../ipc/collabEvents", () => ({
  onCollabStatus: async (cb: (s: CollabStatus) => void) => {
    ipc.statusHandler = cb;
    return () => {
      ipc.statusHandler = null;
    };
  },
}));

import { COLLAB_STATUS_OFF } from "../ipc/commands";
import {
  useCollabStore,
  __resetCollabStoreForTests,
  buildShareLink,
  parseShareLink,
  generateRoomId,
  generateRoomKey,
  selectShareLink,
  selectLocalLink,
} from "./collabStore";
import { useSettingsStore, __resetSettingsForTests } from "./settingsStore";

function running(over: Partial<CollabStatus> = {}): CollabStatus {
  return {
    running: true,
    roomId: null,
    localPort: 4780,
    localBase: "http://127.0.0.1:4780",
    publicBase: null,
    tunnel: { mode: "auto", state: "starting", error: null },
    peerCount: 0,
    ...over,
  };
}

const ROOM = "0123456789abcdef0123";
const KEY = "AAAAAAAAAAAAAAAAAAAAAA";

describe("collab link helpers", () => {
  it("generates contract-shaped room ids and keys", () => {
    expect(generateRoomId()).toMatch(/^[0-9a-f]{20}$/);
    expect(generateRoomKey()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(generateRoomId()).not.toBe(generateRoomId());
  });

  it("round-trips build/parse", () => {
    const link = { publicBase: "https://abc-4780.usw3.devtunnels.ms", roomId: ROOM, key: KEY };
    const url = buildShareLink(link);
    expect(url).toBe(`https://abc-4780.usw3.devtunnels.ms/#room=${ROOM},${KEY}`);
    expect(parseShareLink(`  ${url}  `)).toEqual(link);
  });

  it("rejects malformed links", () => {
    expect(parseShareLink("https://x.test/")).toBeNull();
    expect(parseShareLink(`https://x.test/#room=XYZ,${KEY}`)).toBeNull();
    expect(parseShareLink(`https://x.test/#room=${ROOM},short`)).toBeNull();
    expect(parseShareLink(`ftp://x.test/#room=${ROOM},${KEY}`)).toBeNull();
    expect(parseShareLink(`#room=${ROOM},${KEY}`)).toBeNull();
  });
});

describe("collabStore", () => {
  beforeEach(() => {
    __resetCollabStoreForTests();
    __resetSettingsForTests();
    ipc.collabStart.mockReset();
    ipc.collabStop.mockReset().mockResolvedValue(COLLAB_STATUS_OFF);
    ipc.collabStatus.mockReset().mockResolvedValue(COLLAB_STATUS_OFF);
    useSettingsStore.setState({ collab: true });
  });

  it("refuses to host when the collab toggle is off", async () => {
    useSettingsStore.setState({ collab: false });
    await useCollabStore.getState().startHosting("t1");
    expect(ipc.collabStart).not.toHaveBeenCalled();
    expect(useCollabStore.getState().session).toBeNull();
    expect(useCollabStore.getState().error).toMatch(/turned off/);
  });

  it("startHosting passes settings to collab_start and tracks status events", async () => {
    useSettingsStore.setState({
      collabPort: 5000,
      collabTunnelMode: "manual",
      collabManualUrl: "https://me.example.com",
    });
    ipc.collabStart.mockImplementation(async (a) => running({ roomId: a.roomId }));
    await useCollabStore.getState().init();
    await useCollabStore.getState().startHosting("t1");

    const args = ipc.collabStart.mock.calls[0][0];
    expect(args).toMatchObject({
      port: 5000,
      tunnel: "manual",
      manualUrl: "https://me.example.com",
    });
    const { session } = useCollabStore.getState();
    expect(session).toMatchObject({ role: "host", tabId: "t1", roomId: args.roomId });
    expect(session?.publicBase).toBeNull();
    expect(selectShareLink(useCollabStore.getState())).toBeNull();
    expect(selectLocalLink(useCollabStore.getState())).toBe(
      `http://127.0.0.1:4780/#room=${args.roomId},${session?.key}`,
    );

    ipc.statusHandler?.(
      running({
        roomId: args.roomId,
        publicBase: "https://me.example.com",
        tunnel: { mode: "manual", state: "ready", error: null },
        peerCount: 2,
      }),
    );
    const s = useCollabStore.getState();
    expect(s.status.peerCount).toBe(2);
    expect(selectShareLink(s)).toBe(`https://me.example.com/#room=${args.roomId},${session?.key}`);
  });

  it("omits manualUrl outside manual mode", async () => {
    useSettingsStore.setState({ collabTunnelMode: "local", collabManualUrl: "https://x.test" });
    ipc.collabStart.mockResolvedValue(running());
    await useCollabStore.getState().startHosting("t1");
    expect(ipc.collabStart.mock.calls[0][0]).not.toHaveProperty("manualUrl");
  });

  it("clears the session and surfaces the error when collab_start fails", async () => {
    ipc.collabStart.mockRejectedValue({ kind: "other", message: "port in use" });
    await useCollabStore.getState().startHosting("t1");
    expect(useCollabStore.getState().session).toBeNull();
    expect(useCollabStore.getState().error).toBe("port in use");
    expect(useCollabStore.getState().starting).toBe(false);
  });

  it("stopHosting calls collab_stop and clears the host session", async () => {
    ipc.collabStart.mockResolvedValue(running());
    await useCollabStore.getState().startHosting("t1");
    await useCollabStore.getState().stopHosting();
    expect(ipc.collabStop).toHaveBeenCalledTimes(1);
    expect(useCollabStore.getState().session).toBeNull();
    expect(useCollabStore.getState().status.running).toBe(false);
  });

  it("drops the host session if the relay reports it stopped", async () => {
    ipc.collabStart.mockResolvedValue(running());
    await useCollabStore.getState().init();
    await useCollabStore.getState().startHosting("t1");
    ipc.statusHandler?.(COLLAB_STATUS_OFF);
    expect(useCollabStore.getState().session).toBeNull();
  });

  it("only one session at a time", async () => {
    ipc.collabStart.mockResolvedValue(running());
    await useCollabStore.getState().startHosting("t1");
    expect(useCollabStore.getState().joinSession(`https://x.test/#room=${ROOM},${KEY}`, "t2")).toBe(
      false,
    );
    expect(useCollabStore.getState().session?.tabId).toBe("t1");
  });

  it("joinSession binds a tab as guest; invalid links are rejected", () => {
    expect(useCollabStore.getState().joinSession("nope", "t2")).toBe(false);
    expect(useCollabStore.getState().error).toMatch(/valid session link/);
    expect(useCollabStore.getState().joinSession(`https://x.test/#room=${ROOM},${KEY}`, "t2")).toBe(
      true,
    );
    expect(useCollabStore.getState().session).toEqual({
      role: "guest",
      tabId: "t2",
      roomId: ROOM,
      key: KEY,
      publicBase: "https://x.test",
    });
    expect(ipc.collabStart).not.toHaveBeenCalled();
  });

  it("endSessionForTab stops hosting only for the bound tab", async () => {
    ipc.collabStart.mockResolvedValue(running());
    await useCollabStore.getState().startHosting("t1");
    await useCollabStore.getState().endSessionForTab("other");
    expect(ipc.collabStop).not.toHaveBeenCalled();
    await useCollabStore.getState().endSessionForTab("t1");
    expect(ipc.collabStop).toHaveBeenCalledTimes(1);
    expect(useCollabStore.getState().session).toBeNull();
  });

  it("endSessionForTab leaves a guest session without IPC", async () => {
    useCollabStore.getState().joinSession(`https://x.test/#room=${ROOM},${KEY}`, "t2");
    await useCollabStore.getState().endSessionForTab("t2");
    expect(useCollabStore.getState().session).toBeNull();
    expect(ipc.collabStop).not.toHaveBeenCalled();
  });
});

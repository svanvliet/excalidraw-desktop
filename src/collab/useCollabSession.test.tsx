vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = (() => ({})) as never;
});

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles, SceneData } from "@excalidraw/excalidraw/types";

import type { CollabApi } from "./CollabSession";
import { MemoryRelay } from "./memoryRelay";
import type { RoomLink } from "./protocol";
import { useCollabSession, type UseCollabSessionOptions } from "./useCollabSession";

const LINK: RoomLink = {
  publicBase: "http://127.0.0.1:4780",
  roomId: "0123456789abcdef0123",
  key: "AAAAAAAAAAAAAAAAAAAAAA",
};

function fakeApi(elements: unknown[] = []): CollabApi & { scene: SceneData[] } {
  let els = elements as OrderedExcalidrawElement[];
  const scene: SceneData[] = [];
  return {
    scene,
    updateScene: ((d: SceneData) => {
      scene.push(d);
      if (d.elements) els = d.elements as OrderedExcalidrawElement[];
    }) as CollabApi["updateScene"],
    getSceneElementsIncludingDeleted: () => els,
    getAppState: () => ({ selectedElementIds: {} }) as unknown as AppState,
    getFiles: () => ({}) as BinaryFiles,
    addFiles: () => {},
  };
}

describe("useCollabSession", () => {
  it("stays idle without a link or api", () => {
    const { result } = renderHook(() =>
      useCollabSession({ api: null, link: LINK, username: "a", isHost: true }),
    );
    expect(result.current.status).toBe("idle");
    expect(result.current.session).toBeNull();
    // Handlers are safe no-ops before a session exists.
    result.current.handlers.onPointerUpdate({
      pointer: { x: 0, y: 0, tool: "pointer" },
      button: "up",
    });
  });

  it("connects, tracks peers, renames, and stops on unmount", async () => {
    const relay = new MemoryRelay();
    const createTransport = () => relay.createTransport();
    const hostApi = fakeApi();
    const guestApi = fakeApi();
    const onRemoteChange = vi.fn();

    const host = renderHook(() =>
      useCollabSession({
        api: hostApi,
        link: LINK,
        username: "Host",
        isHost: true,
        createTransport,
      }),
    );
    const guest = renderHook(
      (props: Partial<UseCollabSessionOptions>) =>
        useCollabSession({
          api: guestApi,
          link: LINK,
          username: "Guest",
          isHost: false,
          createTransport,
          onRemoteChange,
          ...props,
        }),
      { initialProps: {} },
    );

    await waitFor(() => expect(host.result.current.status).toBe("connected"));
    await waitFor(() =>
      expect(host.result.current.peers).toEqual([
        expect.objectContaining({ username: "Guest", isHost: false }),
      ]),
    );
    expect(guest.result.current.session).not.toBeNull();

    guest.rerender({ username: "Renamed" });
    await waitFor(() => expect(host.result.current.peers[0]?.username).toBe("Renamed"));

    act(() => guest.unmount());
    await waitFor(() => expect(host.result.current.peers).toEqual([]));
    host.unmount();
  });

  it("restarts when the room changes", async () => {
    const relay = new MemoryRelay();
    const createTransport = vi.fn(() => relay.createTransport());
    const api = fakeApi();
    const { result, rerender } = renderHook(
      ({ link }: { link: RoomLink | null }) =>
        useCollabSession({ api, link, username: "a", isHost: true, createTransport }),
      { initialProps: { link: LINK as RoomLink | null } },
    );
    await waitFor(() => expect(result.current.status).toBe("connected"));
    rerender({ link: { ...LINK, roomId: "ffffffffffffffffffff" } });
    await waitFor(() => expect(result.current.status).toBe("connected"));
    expect(createTransport).toHaveBeenCalledTimes(2);
    rerender({ link: null });
    expect(result.current.status).toBe("idle");
  });
});

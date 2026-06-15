import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDocumentState } from "./documentStore";

describe("useDocumentState", () => {
  it("starts with an unsaved, clean document", () => {
    const { result } = renderHook(() => useDocumentState());
    expect(result.current.state).toEqual({ path: null, dirty: false });
  });

  it("markOpened sets the path and clears dirty", () => {
    const { result } = renderHook(() => useDocumentState());
    act(() => result.current.markOpened("/tmp/foo.excalidraw"));
    expect(result.current.state).toEqual({ path: "/tmp/foo.excalidraw", dirty: false });
  });

  it("markDirty flips dirty true and is idempotent", () => {
    const { result } = renderHook(() => useDocumentState());
    act(() => result.current.markDirty());
    const afterFirst = result.current.state;
    act(() => result.current.markDirty());
    expect(result.current.state.dirty).toBe(true);
    expect(result.current.state).toBe(afterFirst);
  });

  it("markSaved keeps the path and clears dirty", () => {
    const { result } = renderHook(() => useDocumentState());
    act(() => result.current.markOpened("/tmp/foo.excalidraw"));
    act(() => result.current.markDirty());
    expect(result.current.state.dirty).toBe(true);
    act(() => result.current.markSaved("/tmp/foo.excalidraw"));
    expect(result.current.state).toEqual({ path: "/tmp/foo.excalidraw", dirty: false });
  });

  it("reset returns to the initial unsaved state", () => {
    const { result } = renderHook(() => useDocumentState());
    act(() => result.current.markOpened("/tmp/foo.excalidraw"));
    act(() => result.current.reset());
    expect(result.current.state).toEqual({ path: null, dirty: false });
  });
});

/**
 * Single-document state for M2. Will be replaced by a full tabs store
 * (Zustand) in M3 — keeping the shape narrow now makes that swap trivial.
 */
import { useCallback, useState } from "react";

export interface DocumentState {
  /** Absolute path on disk, or `null` if the document has never been saved. */
  path: string | null;
  /** True when in-memory state differs from what's on disk. */
  dirty: boolean;
}

const initialState: DocumentState = { path: null, dirty: false };

/**
 * Lightweight document state hook. Returns the current state plus stable
 * setters for the three lifecycle transitions a document goes through.
 */
export function useDocumentState() {
  const [state, setState] = useState<DocumentState>(initialState);

  const markOpened = useCallback((path: string) => {
    setState({ path, dirty: false });
  }, []);

  const markSaved = useCallback((path: string) => {
    setState({ path, dirty: false });
  }, []);

  const markDirty = useCallback(() => {
    setState((prev) => (prev.dirty ? prev : { ...prev, dirty: true }));
  }, []);

  const reset = useCallback(() => setState(initialState), []);

  return { state, markOpened, markSaved, markDirty, reset };
}

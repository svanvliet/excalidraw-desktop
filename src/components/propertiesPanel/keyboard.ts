/**
 * Keeps Excalidraw's shortcuts (Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z, …) working around our panel
 * sections. They are React siblings of `<Excalidraw>` portalled into its DOM, so React routes their
 * key events to our tree, never to the container's `onKeyDown` where Excalidraw handles keys.
 *
 * - Ctrl/Cmd keydowns from a non-text control (button, slider) are re-dispatched on the
 *   container. Text inputs keep them: typing and the input's own text undo work as usual, the
 *   same as Excalidraw's own panel inputs.
 * - When focus drops out of a section to `<body>` (an input committed on Enter, a control was
 *   disabled or removed), or a focus-keeping button is pressed while nothing has focus, focus
 *   goes to the container so shortcuts keep reaching it.
 */

/** Marks a node whose subtree is ours; set on every section host and the dock. */
export const PANEL_HOST_ATTR = "data-props-host";

/** Mirrors Excalidraw's `isWritableElement`: targets where keys mean text editing. */
export function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  return (
    target instanceof HTMLInputElement &&
    ["text", "number", "password", "search", "email", "url", "tel"].includes(target.type)
  );
}

const inPanel = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest(`[${PANEL_HOST_ATTR}]`);

const isBody = (el: Element | null) =>
  !el || el === document.body || el === document.documentElement;

function redispatch(container: HTMLElement, e: KeyboardEvent) {
  const copy = new KeyboardEvent("keydown", {
    key: e.key,
    code: e.code,
    location: e.location,
    repeat: e.repeat,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    bubbles: true,
    cancelable: true,
  });
  container.dispatchEvent(copy);
  if (copy.defaultPrevented) e.preventDefault();
}

/** Wires the bridge on Excalidraw's container (`.excalidraw-container`); returns the cleanup. */
export function bridgePanelKeys(container: HTMLElement): () => void {
  // Whether the last focused element was in one of our sections; covers focus lost without a
  // focusout (a focused node removed or disabled).
  let panelFocused = false;
  let pending = 0;

  const refocus = () => {
    if (container.isConnected && isBody(document.activeElement)) {
      container.focus({ preventScroll: true });
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || !inPanel(e.target) || isTextTarget(e.target)) return;
    redispatch(container, e);
  };
  const onPointerDown = (e: PointerEvent) => {
    if (inPanel(e.target)) refocus();
  };
  const onFocusIn = (e: FocusEvent) => {
    panelFocused = inPanel(e.target);
  };
  const onFocusOut = (e: FocusEvent) => {
    if (!inPanel(e.target) || e.relatedTarget) return;
    clearTimeout(pending);
    pending = window.setTimeout(refocus);
  };
  const onDocumentKeyDown = (e: KeyboardEvent) => {
    if (!panelFocused || !isBody(e.target as Element | null)) return;
    panelFocused = false;
    refocus();
    if (e.ctrlKey || e.metaKey) redispatch(container, e);
  };

  container.addEventListener("keydown", onKeyDown);
  container.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("focusin", onFocusIn);
  container.addEventListener("focusout", onFocusOut);
  document.addEventListener("keydown", onDocumentKeyDown);
  return () => {
    clearTimeout(pending);
    container.removeEventListener("keydown", onKeyDown);
    container.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("focusin", onFocusIn);
    container.removeEventListener("focusout", onFocusOut);
    document.removeEventListener("keydown", onDocumentKeyDown);
  };
}

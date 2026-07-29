const PANEL_PADDING = 8;

export interface PanelBounds {
  width: number;
  height: number;
}

export interface PanelPosition {
  x: number;
  y: number;
}

export function clampPanelPosition(
  position: PanelPosition,
  panelBounds: PanelBounds,
  containerBounds: PanelBounds,
  padding = PANEL_PADDING,
): PanelPosition {
  const minX = padding;
  const minY = padding;
  const maxX = Math.max(minX, containerBounds.width - panelBounds.width - padding);
  const maxY = Math.max(minY, containerBounds.height - panelBounds.height - padding);
  return {
    x: Math.min(Math.max(position.x, minX), maxX),
    y: Math.min(Math.max(position.y, minY), maxY),
  };
}

export function enableDraggablePropertiesPanel(canvasRoot: HTMLElement): () => void {
  let teardownCurrent: (() => void) | null = null;
  let observer: MutationObserver | null = null;
  let lastPosition: PanelPosition | null = null;
  let rafId: number | null = null;

  const mountOnVisiblePanel = () => {
    const panel = canvasRoot.querySelector<HTMLElement>(".App-menu__left");
    if (!panel) return;
    if (panel.dataset.desktopDraggableReady === "true") return;
    teardownCurrent?.();
    teardownCurrent = mountPanel(panel);
  };

  const scheduleMount = () => {
    if (rafId !== null) return;
    rafId = window.requestAnimationFrame(() => {
      rafId = null;
      mountOnVisiblePanel();
    });
  };

  const mountPanel = (panel: HTMLElement): (() => void) => {
    panel.dataset.desktopDraggableReady = "true";
    panel.classList.add("App-menu__left--draggable");

    const dragHandle = document.createElement("button");
    dragHandle.type = "button";
    dragHandle.className = "App-menu__left-drag-handle";
    const grip = document.createElement("span");
    grip.className = "App-menu__left-drag-grip";
    grip.setAttribute("aria-hidden", "true");
    dragHandle.append(grip);
    dragHandle.title = "Drag to reposition panel";
    dragHandle.setAttribute("aria-label", "Drag to reposition panel");
    panel.prepend(dragHandle);

    const applyPosition = (position: PanelPosition) => {
      const rootRect = canvasRoot.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const clamped = clampPanelPosition(
        position,
        { width: panelRect.width, height: panelRect.height },
        { width: rootRect.width, height: rootRect.height },
      );
      panel.style.left = `${clamped.x}px`;
      panel.style.top = `${clamped.y}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      lastPosition = clamped;
    };

    const rootRect = canvasRoot.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const initialPosition =
      lastPosition ?? ({ x: panelRect.left - rootRect.left, y: panelRect.top - rootRect.top } as const);
    applyPosition(initialPosition);

    const onResize = () => {
      if (!lastPosition) return;
      applyPosition(lastPosition);
    };
    window.addEventListener("resize", onResize);

    let dragState:
      | {
          pointerId: number;
          startX: number;
          startY: number;
          startLeft: number;
          startTop: number;
        }
      | null = null;

    const onPointerMove = (event: PointerEvent) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      const deltaX = event.clientX - dragState.startX;
      const deltaY = event.clientY - dragState.startY;
      applyPosition({
        x: dragState.startLeft + deltaX,
        y: dragState.startTop + deltaY,
      });
    };

    const endDrag = (event: PointerEvent) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      dragState = null;
      dragHandle.classList.remove("is-dragging");
      dragHandle.releasePointerCapture(event.pointerId);
      dragHandle.removeEventListener("pointermove", onPointerMove);
      dragHandle.removeEventListener("pointerup", endDrag);
      dragHandle.removeEventListener("pointercancel", endDrag);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const left = Number.parseFloat(panel.style.left || "0");
      const top = Number.parseFloat(panel.style.top || "0");
      dragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startLeft: Number.isFinite(left) ? left : 0,
        startTop: Number.isFinite(top) ? top : 0,
      };
      dragHandle.classList.add("is-dragging");
      dragHandle.setPointerCapture(event.pointerId);
      dragHandle.addEventListener("pointermove", onPointerMove);
      dragHandle.addEventListener("pointerup", endDrag);
      dragHandle.addEventListener("pointercancel", endDrag);
    };

    dragHandle.addEventListener("pointerdown", onPointerDown);

    return () => {
      dragHandle.removeEventListener("pointerdown", onPointerDown);
      dragHandle.removeEventListener("pointermove", onPointerMove);
      dragHandle.removeEventListener("pointerup", endDrag);
      dragHandle.removeEventListener("pointercancel", endDrag);
      if (dragHandle.isConnected) {
        dragHandle.remove();
      }
      window.removeEventListener("resize", onResize);
      panel.classList.remove("App-menu__left--draggable");
      delete panel.dataset.desktopDraggableReady;
      teardownCurrent = null;
    };
  };

  mountOnVisiblePanel();
  observer = new MutationObserver(() => scheduleMount());
  observer.observe(canvasRoot, { childList: true, subtree: true });

  return () => {
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    observer?.disconnect();
    observer = null;
    teardownCurrent?.();
    teardownCurrent = null;
  };
}

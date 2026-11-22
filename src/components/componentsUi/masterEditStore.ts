/**
 * Which editor is editing a component master, and which instance it opened from (FR-66). One
 * session at a time across the app; the editor that owns it mounts `MasterEditor` over itself.
 */
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { create } from "zustand";
import type { El } from "../../agent/scene/draft";
import { listComponents } from "../../extensions/components/model";
import { componentOfInstanceGroup } from "./masterEditScene";

type Api = ExcalidrawImperativeAPI;

export interface MasterEditSession {
  api: Api;
  instanceGroupId: string;
  /** The main editor's sidebar when the overlay opened; put back on close. */
  sidebar: AppState["openSidebar"];
}

interface MasterEditState {
  session: MasterEditSession | null;
  close(): void;
}

export const useMasterEditStore = create<MasterEditState>((set) => ({
  session: null,
  close: () => set({ session: null }),
}));

const overlays = new WeakSet<Api>();

/** Marks `api` as a master-edit overlay (its panel hides commands that only make sense on a drawing). */
export function registerMasterEditorApi(api: Api) {
  overlays.add(api);
}

export function isMasterEditorApi(api: unknown): boolean {
  return !!api && overlays.has(api as Api);
}

/** Opens the master editor over `api` for the component `instanceGroupId` is an instance of. */
export function openMasterEditor(api: Api, instanceGroupId: string): boolean {
  if (useMasterEditStore.getState().session || isMasterEditorApi(api)) return false;
  const s = api.getAppState();
  if (s.viewModeEnabled) return false;
  if (!componentOfInstanceGroup(api.getSceneElements() as readonly El[], instanceGroupId))
    return false;
  useMasterEditStore.setState({
    session: { api, instanceGroupId, sidebar: s.openSidebar },
  });
  return true;
}

/**
 * Opens the master editor from the Components panel: on the selected instance of the component,
 * else one in view, else its first top-level instance (scrolled into view first).
 */
export function openMasterEditorForComponent(api: Api, componentId: string): boolean {
  const els = api.getSceneElements() as readonly El[];
  const info = listComponents(els).find((c) => c.componentId === componentId);
  if (!info?.instances.length) return false;
  const s = api.getAppState();
  const selected = info.instances.find((i) => s.selectedGroupIds[i.groupId]);
  const byId = new Map(els.map((e) => [e.id, e]));
  const view = {
    minX: -s.scrollX,
    minY: -s.scrollY,
    maxX: -s.scrollX + s.width / s.zoom.value,
    maxY: -s.scrollY + s.height / s.zoom.value,
  };
  const inView = (ids: string[]) =>
    ids.some((id) => {
      const e = byId.get(id);
      return (
        !!e &&
        e.x + e.width >= view.minX &&
        e.x <= view.maxX &&
        e.y + e.height >= view.minY &&
        e.y <= view.maxY
      );
    });
  const top = info.instances.filter((i) => !i.parent);
  const target =
    selected ??
    top.find((i) => inView(i.ids)) ??
    info.instances.find((i) => inView(i.ids)) ??
    top[0] ??
    info.instances[0];
  if (inView(target.ids)) return openMasterEditor(api, target.groupId);
  const members = target.ids.flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []));
  api.updateScene({
    appState: { selectedElementIds: {}, selectedGroupIds: {} } as never,
    captureUpdate: CaptureUpdateAction.NEVER,
  });
  api.scrollToContent(members, { animate: false });
  // The overlay copies the viewport, so let the scroll land first.
  requestAnimationFrame(() => void openMasterEditor(api, target.groupId));
  return true;
}

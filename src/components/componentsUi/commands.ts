/** Components-tab and properties-panel commands that aren't components themselves. */
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, LibraryItem } from "@excalidraw/excalidraw/types";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useSyncExternalStore } from "react";
import { ToolError, type El } from "../../agent/scene/draft";
import { listComponents } from "../../extensions/components/model";
import { isTauri, saveFile } from "../../ipc/commands";
import {
  getMyComponents,
  loadMyComponents,
  putMyComponent,
  subscribeMyComponents,
  type MyComponent,
} from "../../lib/componentLibraryStore";
import { log } from "../../lib/logger";
import { placeMyComponent } from "./insert";
import { entriesToExcalidrawLib, libraryItemToEntry, masterToEntry } from "./libraryCodec";

type Api = ExcalidrawImperativeAPI;

const subscribe = (cb: () => void) => subscribeMyComponents(cb);

/** "My components", loading it on first use. */
export function useMyComponents(): readonly MyComponent[] {
  useEffect(() => void loadMyComponents(), []);
  return useSyncExternalStore(subscribe, getMyComponents, getMyComponents);
}

export function toast(api: Api, message: string) {
  api.setToast({ message, duration: 3000 });
}

/**
 * Select a component's master and scroll it into view; when its master lives off-canvas
 * (FR-64), its first top-level instance.
 */
export function goToMaster(api: Api, componentId: string) {
  const els = api.getSceneElements() as readonly El[];
  const info = listComponents(els).find((c) => c.componentId === componentId);
  const target = info?.masterGroupId
    ? { group: info.masterGroupId, ids: info.masterIds }
    : (info?.instances.find((i) => !i.parent) ?? info?.instances[0]);
  const group = target && ("group" in target ? target.group : target.groupId);
  const ids = new Set(target?.ids ?? []);
  const master = els.filter((e) => ids.has(e.id));
  if (!master.length || !group) return;
  api.updateScene({
    appState: {
      selectedGroupIds: { [group]: true },
      selectedElementIds: Object.fromEntries(master.map((e) => [e.id, true as const])),
      editingGroupId: null,
    } as never,
    captureUpdate: CaptureUpdateAction.NEVER,
  });
  api.scrollToContent(master, { animate: true });
}

/** Save a drawing's component to My components (replacing an earlier save of it). */
export async function saveToMyComponents(api: Api, componentId: string): Promise<boolean> {
  try {
    const entry = masterToEntry(
      api.getSceneElements() as readonly El[],
      api.getFiles(),
      componentId,
    );
    const replacing = getMyComponents().some((c) => c.id === componentId);
    if (!(await putMyComponent(entry))) {
      toast(api, "Couldn't save to My components. See the log for details.");
      return false;
    }
    toast(
      api,
      replacing
        ? `Updated "${entry.name}" in My components`
        : `Saved "${entry.name}" to My components`,
    );
    return true;
  } catch (err) {
    if (err instanceof ToolError) toast(api, err.message);
    else log.error("components: save to My components failed", err);
    return false;
  }
}

export async function makeFromLibraryItem(api: Api, item: LibraryItem, canSave: boolean) {
  let entry: MyComponent;
  try {
    entry = libraryItemToEntry(item);
  } catch (err) {
    if (err instanceof ToolError) toast(api, err.message);
    else log.error("components: library item → component failed", err);
    return;
  }
  if (canSave && (await putMyComponent(entry))) {
    toast(api, `"${entry.name}" is now in My components. Click it to place it.`);
    return;
  }
  // Can't save (e.g. a live-collab guest): put it straight into this drawing instead.
  placeMyComponent(api, entry);
}

export async function exportLibrary(api: Api, entries: readonly MyComponent[]) {
  if (!entries.length) return;
  const { json, droppedImages } = entriesToExcalidrawLib(entries);
  try {
    if (isTauri()) {
      const path = await saveDialog({
        defaultPath: "my-components.excalidrawlib",
        filters: [{ name: "Excalidraw library", extensions: ["excalidrawlib"] }],
      });
      if (!path) return;
      await saveFile(path, json);
    } else {
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "my-components.excalidrawlib";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    toast(
      api,
      droppedImages
        ? `Exported. ${droppedImages} image${droppedImages === 1 ? " was" : "s were"} left out: .excalidrawlib can't hold images.`
        : "Exported My components",
    );
  } catch (err) {
    log.error("components: export failed", err);
    toast(api, "Couldn't export My components. See the log for details.");
  }
}

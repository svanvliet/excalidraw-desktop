import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ReactNode } from "react";
import {
  createComponentFromSelection,
  detachComponentInstance,
  resetInstanceOverrides,
} from "../../extensions/components/host";
import { canSaveMyComponents } from "../../lib/componentLibraryStore";
import { CloseIcon } from "../icons";
import type { PanelApi } from "../propertiesPanel/panel";
import { goToMaster, saveToMyComponents, useMyComponents } from "./commands";
import { keyLabel, type ComponentView } from "./componentPanelSection";
import {
  editLibraryMaster,
  libraryMasterEngine,
  moveMasterToLibrary,
  useMasterEdit,
} from "./libraryMasters";

/** Keeps Excalidraw's canvas focused so its shortcuts (undo!) keep working after a click. */
const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

function Action({
  testId,
  onClick,
  disabled,
  title,
  children,
}: {
  testId: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="component-props__btn"
      data-testid={testId}
      title={title}
      disabled={disabled}
      onMouseDown={keepFocus}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function ComponentSection({ view, api: panelApi }: { view: ComponentView; api: PanelApi }) {
  // The host hands sections the full editor API; PanelApi only narrows what most sections use.
  const api = panelApi as ExcalidrawImperativeAPI;
  const mine = useMyComponents();
  const editing = useMasterEdit(api);
  const engine = !!libraryMasterEngine();
  const canSave = canSaveMyComponents();

  if (view.kind === "create") {
    return (
      <fieldset className="component-props">
        <legend>Component</legend>
        <div className="component-props__actions">
          <Action
            testId="component-create"
            title="Alt/Option + Cmd/Ctrl + K"
            onClick={() => createComponentFromSelection(api)}
          >
            Create component
          </Action>
        </div>
      </fieldset>
    );
  }

  if (view.kind === "master") {
    const n = view.instances;
    const saved = mine.some((m) => m.id === view.componentId);
    return (
      <fieldset className="component-props">
        <legend>Component master</legend>
        <div className="component-props__summary" data-testid="component-props-summary">
          <strong>{view.name}</strong> · {n} instance{n === 1 ? "" : "s"}
        </div>
        {editing?.componentId === view.componentId ? (
          <div className="component-props__note">
            Editing from My components. Use Done or Cancel at the top of the canvas.
          </div>
        ) : (
          <div className="component-props__actions">
            <Action
              testId="component-save"
              disabled={!canSave}
              onClick={() => void saveToMyComponents(api, view.componentId)}
            >
              {saved ? "Update in My components" : "Save to My components"}
            </Action>
            {engine && (
              <Action
                testId="component-move-to-library"
                disabled={!canSave}
                title="Saves it to My components and takes the master off the canvas"
                onClick={() => void moveMasterToLibrary(api, view.componentId)}
              >
                Move to My components
              </Action>
            )}
          </div>
        )}
      </fieldset>
    );
  }

  const inLibrary = mine.some((m) => m.id === (view.libraryId ?? view.componentId));
  const libraryOnly = view.libraryBacked && !view.hasMaster;
  return (
    <fieldset className="component-props">
      <legend>Component instance</legend>
      <div className="component-props__summary" data-testid="component-props-summary">
        <strong>{view.name}</strong>
        {libraryOnly && " · from My components"}
      </div>
      <div className="component-props__actions">
        {view.hasMaster && (
          <Action testId="component-go-to-master" onClick={() => goToMaster(api, view.componentId)}>
            Go to master
          </Action>
        )}
        {libraryOnly && engine && !editing && (
          <Action
            testId="component-edit-master"
            disabled={!canSave}
            title="Puts the master on the canvas until you choose Done or Cancel"
            onClick={() => editLibraryMaster(api, view.groupId)}
          >
            Edit master…
          </Action>
        )}
        {(view.hasMaster || libraryOnly) && (
          <Action
            testId="component-save"
            disabled={!canSave}
            onClick={() => void saveToMyComponents(api, view.componentId)}
          >
            {inLibrary ? "Update in My components" : "Save to My components"}
          </Action>
        )}
        <Action
          testId="component-reset"
          disabled={!view.overrides.length}
          onClick={() => resetInstanceOverrides(api, view.groupId)}
        >
          Reset overrides
        </Action>
        <Action
          testId="component-detach"
          title="Makes it a plain group that no longer follows the master"
          onClick={() => detachComponentInstance(api, view.groupId)}
        >
          Detach
        </Action>
      </div>
      {view.overrides.length > 0 && (
        <div className="component-props__overrides" role="list" aria-label="Overrides">
          {view.overrides.map((o) => (
            <div
              key={o.slot}
              className="component-props__override"
              role="listitem"
              data-testid="component-override"
            >
              <span className="component-props__override-text">
                {o.label}: {o.keys.map(keyLabel).join(", ")}
              </span>
              <button
                type="button"
                className="shape-data__icon"
                title={`Reset ${o.label}`}
                aria-label={`Reset ${o.label}`}
                onMouseDown={keepFocus}
                onClick={() => resetInstanceOverrides(api, view.groupId, { slots: [o.slot] })}
              >
                <CloseIcon size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </fieldset>
  );
}

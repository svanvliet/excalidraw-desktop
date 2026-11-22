import type { KeyboardEvent } from "react";
import {
  makeContainerFromSelection,
  moveContainerChild,
  takeOutOfContainer,
  unmakeContainer,
  updateContainerSettings,
  type ContainerPanelView,
} from "../../layout/containers/host";
import type { ContainerChanges } from "../../layout/containers/actions";
import type { Align, Justify } from "../../layout/containers/model";
import { StackAlignIcon, StackHorizontalIcon, StackJustifyIcon, StackVerticalIcon } from "../icons";
import type { PanelApi } from "../propertiesPanel/panel";
import { ButtonRow, IconButton } from "../propertiesPanel/controls";

const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

const ALIGN_LABEL: Record<Align, [string, string]> = {
  start: ["Align left", "Align top"],
  center: ["Align centre", "Align middle"],
  end: ["Align right", "Align bottom"],
};
const JUSTIFY_LABEL: Record<Justify, string> = {
  start: "Pack at start",
  center: "Pack in centre",
  end: "Pack at end",
  "space-between": "Space evenly",
};

/** A small numeric field that commits on blur / Enter and reverts on Escape. */
function NumberField(props: {
  label: string;
  testId: string;
  value: number | null;
  onCommit(v: number): void;
}) {
  const shown = props.value === null ? "" : String(props.value);
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      e.currentTarget.value = shown;
      e.currentTarget.blur();
    }
  };
  return (
    <label className="container-props__field">
      <span>{props.label}</span>
      <input
        // Remount on external changes (undo, another peer) so the field shows the new value.
        key={shown}
        className="shape-data__input"
        type="number"
        min={0}
        step={4}
        aria-label={props.label}
        data-testid={props.testId}
        defaultValue={shown}
        placeholder={props.value === null ? "Mixed" : undefined}
        onKeyDown={keys}
        onBlur={(e) => {
          const raw = e.currentTarget.value.trim();
          if (raw === shown || raw === "") return void (e.currentTarget.value = shown);
          const v = Number(raw);
          if (Number.isFinite(v)) props.onCommit(v);
          else e.currentTarget.value = shown;
        }}
      />
    </label>
  );
}

function TextButton(props: {
  label: string;
  testId: string;
  danger?: boolean;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className={`container-props__btn${props.danger ? " container-props__btn--danger" : ""}`}
      data-testid={props.testId}
      disabled={props.disabled}
      onMouseDown={keepFocus}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

export function ContainerSection({ view, api }: { view: ContainerPanelView; api: PanelApi }) {
  if (view.mode === "make" || !view.def || !view.containerId) {
    return (
      <fieldset>
        <TextButton
          label="Make container"
          testId="container-make"
          onClick={() => makeContainerFromSelection(api)}
        />
      </fieldset>
    );
  }
  const { def, containerId } = view;
  const vertical = def.direction === "vertical";
  const set = (changes: ContainerChanges) => updateContainerSettings(api, containerId, changes);
  const p = def.padding;
  const uniform = p.top === p.right && p.top === p.bottom && p.top === p.left;

  return (
    <fieldset className="container-props">
      {view.mode === "child" && (
        <div className="container-props__child" data-testid="container-child">
          <span>
            Item {view.index + 1} of {view.count}
          </span>
          <div className="container-props__row">
            <TextButton
              label={vertical ? "Move up" : "Move left"}
              testId="container-child-earlier"
              disabled={view.index === 0}
              onClick={() => moveContainerChild(api, containerId, view.childIds[0], view.index - 1)}
            />
            <TextButton
              label={vertical ? "Move down" : "Move right"}
              testId="container-child-later"
              disabled={view.index >= view.count - 1}
              onClick={() => moveContainerChild(api, containerId, view.childIds[0], view.index + 1)}
            />
          </div>
          <TextButton
            label="Take out of container"
            testId="container-child-remove"
            onClick={() => takeOutOfContainer(api, view.childIds)}
          />
        </div>
      )}
      <ButtonRow legend="Direction" testId="container-direction">
        <IconButton
          label="Vertical stack"
          icon={<StackVerticalIcon />}
          active={vertical}
          onClick={() => set({ direction: "vertical" })}
        />
        <IconButton
          label="Horizontal stack"
          icon={<StackHorizontalIcon />}
          active={!vertical}
          onClick={() => set({ direction: "horizontal" })}
        />
      </ButtonRow>
      <ButtonRow legend="Align" testId="container-align">
        {(["start", "center", "end"] as const).map((a) => (
          <IconButton
            key={a}
            label={ALIGN_LABEL[a][vertical ? 0 : 1]}
            icon={<StackAlignIcon pos={a} vertical={vertical} />}
            active={def.align === a}
            onClick={() => set({ align: a })}
          />
        ))}
      </ButtonRow>
      <div className="container-props__row">
        <NumberField
          label="Gap"
          testId="container-gap"
          value={def.gap}
          onCommit={(gap) => set({ gap })}
        />
        <NumberField
          label="Padding"
          testId="container-padding"
          value={uniform ? p.top : null}
          onCommit={(padding) => set({ padding })}
        />
      </div>
      <ButtonRow legend="Size" testId="container-sizing">
        <IconButton
          label={def.sizing.w === "hug" ? "Width: hug contents" : "Width: fixed"}
          icon={<span className="container-props__size">W</span>}
          active={def.sizing.w === "fixed"}
          onClick={() => set({ sizing: { w: def.sizing.w === "hug" ? "fixed" : "hug" } })}
        />
        <IconButton
          label={def.sizing.h === "hug" ? "Height: hug contents" : "Height: fixed"}
          icon={<span className="container-props__size">H</span>}
          active={def.sizing.h === "fixed"}
          onClick={() => set({ sizing: { h: def.sizing.h === "hug" ? "fixed" : "hug" } })}
        />
      </ButtonRow>
      {(vertical ? def.sizing.h : def.sizing.w) === "fixed" && (
        <ButtonRow legend="Distribute" testId="container-justify">
          {(["start", "center", "end", "space-between"] as const).map((j) => (
            <IconButton
              key={j}
              label={JUSTIFY_LABEL[j]}
              icon={<StackJustifyIcon pos={j} vertical={vertical} />}
              active={def.justify === j}
              onClick={() => set({ justify: j })}
            />
          ))}
        </ButtonRow>
      )}
      {view.mode === "container" && (
        <TextButton
          label="Remove container"
          testId="container-remove"
          danger
          onClick={() => unmakeContainer(api, containerId)}
        />
      )}
    </fieldset>
  );
}

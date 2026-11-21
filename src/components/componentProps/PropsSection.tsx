import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import {
  defineComponentProperty,
  removeComponentProperty,
  setInstanceProperties,
} from "../../extensions/components/host";
import { PROP_TYPES, type PropDef, type PropType } from "../../extensions/components/model";
import { CloseIcon } from "../icons";
import type { PanelApi } from "../propertiesPanel/panel";
import { parseChoices, type PropsView, type PropTargetView } from "./propsPanelSection";

/** Keeps Excalidraw's canvas focused so its shortcuts (undo!) keep working after a click. */
const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

/** Enter commits (via blur); Escape reverts. Both stay away from Excalidraw's shortcuts. */
function commitKeys(e: KeyboardEvent<HTMLInputElement>, original: string) {
  e.stopPropagation();
  if (e.key === "Enter") {
    e.preventDefault();
    e.currentTarget.blur();
  } else if (e.key === "Escape") {
    e.currentTarget.value = original;
    e.currentTarget.blur();
  }
}

const TYPE_LABELS: Record<PropType, string> = {
  text: "Text",
  color: "Colour",
  boolean: "Visibility",
  choice: "Choice",
};

const CHOICE_KEYS = [
  ["backgroundColor", "fill"],
  ["strokeColor", "stroke"],
  ["text", "text"],
  ["opacity", "opacity"],
] as const;

function Reset({ testId, onClick, label }: { testId: string; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      className="shape-data__icon"
      data-testid={testId}
      aria-label={label}
      title={label}
      onMouseDown={keepFocus}
      onClick={onClick}
    >
      <CloseIcon />
    </button>
  );
}

function ValueControl({
  def,
  value,
  testId,
  onSet,
}: {
  def: PropDef;
  value: string | boolean | undefined;
  testId: string;
  onSet: (v: string | boolean | null) => void;
}) {
  if (def.type === "boolean") {
    const on = typeof value === "boolean" ? value : def.default !== false;
    return (
      <input
        type="checkbox"
        className="cmp-propvals__check"
        data-testid={testId}
        checked={on}
        onChange={(e) => onSet(e.currentTarget.checked)}
      />
    );
  }
  if (def.type === "choice") {
    const cur = typeof value === "string" ? value : String(def.default ?? def.options?.[0] ?? "");
    return (
      <select
        className="shape-data__input"
        data-testid={testId}
        value={cur}
        onChange={(e) => onSet(e.currentTarget.value)}
      >
        {def.options?.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  const original = typeof value === "string" ? value : "";
  return (
    <input
      // Remount when the value changes elsewhere (undo, collab) so the field shows it.
      key={original}
      className="shape-data__input"
      data-testid={testId}
      defaultValue={original}
      placeholder={def.type === "color" ? "#rrggbb (master)" : "(master)"}
      spellCheck={false}
      onKeyDown={(e) => commitKeys(e, original)}
      onBlur={(e) => {
        const next = e.currentTarget.value;
        if (next !== original) onSet(next === "" ? null : next);
      }}
    />
  );
}

function TargetRows({
  target,
  onSet,
}: {
  target: PropTargetView;
  onSet: (values: Record<string, string | boolean | null>) => void;
}) {
  const scope = target.nested ?? "own";
  return (
    <div className="cmp-propvals__rows" role="list">
      {target.props.map((def) => {
        const v = target.values[def.id];
        return (
          <div className="cmp-propvals__row" role="listitem" key={def.id}>
            <span className="cmp-propvals__name" title={`${def.name} (${TYPE_LABELS[def.type]})`}>
              {def.name}
            </span>
            <ValueControl
              def={def}
              value={v}
              testId={`propval-${scope}-${def.name}`}
              onSet={(next) => onSet({ [def.id]: next })}
            />
            {v !== undefined ? (
              <Reset
                testId={`propval-reset-${scope}-${def.name}`}
                label={`Reset ${def.name}`}
                onClick={() => onSet({ [def.id]: null })}
              />
            ) : (
              <span />
            )}
          </div>
        );
      })}
    </div>
  );
}

function DeclareForm({
  api,
  view,
}: {
  api: ExcalidrawImperativeAPI;
  view: PropsView & { kind: "master" };
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<PropType>("text");
  const [slot, setSlot] = useState(view.slots[0]?.id ?? "");
  const [choiceKey, setChoiceKey] = useState<string>("backgroundColor");
  const [choices, setChoices] = useState("");
  const slotId = view.slots.some((s) => s.id === slot) ? slot : (view.slots[0]?.id ?? "");

  const add = () => {
    if (!name.trim() || !slotId) return;
    const parsed = type === "choice" ? parseChoices(choices, choiceKey) : null;
    const id = defineComponentProperty(api, view.componentId, {
      name: name.trim(),
      type,
      ...(parsed ? { options: parsed.options } : {}),
      bindings: [{ elementId: slotId, ...(parsed ? { key: choiceKey, map: parsed.map } : {}) }],
    });
    if (id) {
      setName("");
      setChoices("");
    }
  };

  return (
    <div className="cmp-propvals__form" data-testid="propdef-form">
      <input
        className="shape-data__input"
        data-testid="propdef-name"
        placeholder="Property name"
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") add();
        }}
      />
      <div className="cmp-propvals__pair">
        <select
          className="shape-data__input"
          data-testid="propdef-type"
          aria-label="Property type"
          value={type}
          onChange={(e) => setType(e.currentTarget.value as PropType)}
        >
          {PROP_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <select
          className="shape-data__input"
          data-testid="propdef-slot"
          aria-label="Bound element"
          value={slotId}
          onChange={(e) => setSlot(e.currentTarget.value)}
        >
          {view.slots.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      {type === "choice" && (
        <>
          <select
            className="shape-data__input"
            data-testid="propdef-choice-key"
            aria-label="Choice drives"
            value={choiceKey}
            onChange={(e) => setChoiceKey(e.currentTarget.value)}
          >
            {CHOICE_KEYS.map(([k, label]) => (
              <option key={k} value={k}>
                Drives {label}
              </option>
            ))}
          </select>
          <input
            className="shape-data__input"
            data-testid="propdef-choices"
            placeholder="Option=value, Option=value"
            value={choices}
            onChange={(e) => setChoices(e.currentTarget.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </>
      )}
      <button
        type="button"
        className="component-props__btn"
        data-testid="propdef-add"
        disabled={!name.trim() || !slotId}
        onMouseDown={keepFocus}
        onClick={add}
      >
        Add property
      </button>
    </div>
  );
}

function Fieldset({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="cmp-propvals">
      <legend>{legend}</legend>
      {children}
    </fieldset>
  );
}

export function PropsSection({ view, api: panelApi }: { view: PropsView; api: PanelApi }) {
  // The host hands sections the full editor API; PanelApi only narrows what most sections use.
  const api = panelApi as ExcalidrawImperativeAPI;

  if (view.kind === "master") {
    return (
      <Fieldset legend="Properties">
        {view.props.length ? (
          <div className="cmp-propvals__rows" role="list">
            {view.props.map((p) => (
              <div className="cmp-propvals__def" role="listitem" key={p.id}>
                <span className="cmp-propvals__name">
                  {p.name} <span className="cmp-propvals__type">{TYPE_LABELS[p.type]}</span>
                </span>
                <Reset
                  testId={`propdef-remove-${p.name}`}
                  label={`Remove property ${p.name}`}
                  onClick={() => removeComponentProperty(api, view.componentId, p.id)}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="component-props__note">
            Properties let each instance change text, colours, visibility or a choice.
          </div>
        )}
        <DeclareForm api={api} view={view} />
      </Fieldset>
    );
  }

  return (
    <Fieldset legend="Properties">
      {view.targets.map((t) => (
        <div key={t.nested ?? "own"} data-testid={`propvals-${t.nested ? "nested" : "own"}`}>
          {(t.nested || view.targets.length > 1) && (
            <div className="cmp-propvals__title">{t.nested ? `${t.title} (nested)` : t.title}</div>
          )}
          <TargetRows
            target={t}
            onSet={(values) =>
              setInstanceProperties(
                api,
                view.groupId,
                values,
                t.nested ? { nested: t.nested } : undefined,
              )
            }
          />
        </div>
      ))}
    </Fieldset>
  );
}

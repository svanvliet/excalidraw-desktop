/**
 * Body of the "Component" strip row: the component actions, then the component's typed
 * properties (FR-56) under a "Properties" heading. D-DX19 merged the separate Properties row
 * into this one.
 */
import { PropsSection } from "../componentProps/PropsSection";
import type { PanelApi } from "../propertiesPanel/panel";
import { ComponentSection } from "./ComponentSection";
import type { ComponentRowView } from "./componentPanelSection";

export function ComponentRow({ view, api }: { view: ComponentRowView; api: PanelApi }) {
  const { props, ...component } = view;
  return (
    <>
      <ComponentSection view={component} api={api} />
      {props && (
        <div className="component-row__props" data-testid="component-propvals">
          <div className="component-row__heading">Properties</div>
          <PropsSection view={props} api={api} />
        </div>
      )}
    </>
  );
}

/** Components v1 (docs/components.md): masters on the canvas with live-synced instances. */
export * from "./model";
export {
  componentsOf,
  createComponent,
  defineProperty,
  detachInstance,
  insertInstance,
  instanceProperties,
  removeProperty,
  resetOverrides,
  resolveInstance,
  setOverrides,
  setProperties,
  syncDraft,
  type InsertOptions,
  type OverrideEntry,
  type PropertyInput,
  type PropertyTarget,
} from "./actions";
export { componentsOnDuplicate } from "./duplicate";
export { adoptAsMaster, dematerialize, materialize, type ComponentDefinition } from "./library";
export * from "./host";

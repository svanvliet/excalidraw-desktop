/** Components (docs/components.md): live-synced instances of masters kept off-canvas. */
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
export {
  adoptAsMaster,
  applyMasterEdit,
  closeMaster,
  dematerialize,
  demoteMaster,
  liveMasterGroup,
  masterSnapshot,
  materialize,
  openMaster,
  withMaster,
  type ComponentDefinition,
  type MasterSnapshot,
  type OpenedMaster,
} from "./library";
export * from "./host";

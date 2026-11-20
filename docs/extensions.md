# Desktop extensions

> Design contract for features the app adds on top of Excalidraw **without changing the
> `.excalidraw` format**. Code: `src/extensions/`. Built-in extensions: image Mask and Border, stackable.

## 1. Problem

Some features the user wants (masking an image to a circle, for example) aren't in Excalidraw's
schema. We depend on `@excalidraw/excalidraw` from npm and never fork it (CLAUDE.md § 8), so we can't
add element types or renderer features. We also want the same feature for people and for the AI
agent: the agent can only do what the UI can, and vice versa.

## 2. Core idea: a chain of intents plus standard output

An extension is a built-in module that turns **intent** into **standard Excalidraw output**. Image
extensions are **stages of one pipeline**: an element carries an ordered chain of extensions that
share one recorded original and one output file.

- **Intent** is stored on the element in `element.customData.excalidrawDesktop` (`EXT_KEY`):

  ```jsonc
  {
    "v": 2, // stack format version (STACK_VERSION)
    "chain": [
      // canonical order, at most one link per extension
      { "ext": "mask", "v": 1, "params": { "shape": "circle" } },
      { "ext": "border", "v": 1, "params": { "width": 4, "color": "#868e96", "opacity": 100 } },
    ],
    "source": { "fileId": "…", "x": 0, "y": 0, "width": 640, "height": 480, "crop": null, … },
    "outputFileId": "…", // the file the whole chain produced
  }
  ```

  `customData` is part of the published schema. Excalidraw persists it, syncs it in collab and copies
  it on paste, but otherwise ignores it.

- **Output** is ordinary element fields plus `BinaryFiles` (for example a PNG with the mask baked
  into its alpha channel and the border painted on). Because of that, the drawing renders
  identically in stock Excalidraw, excalidraw.com, exports, PNG embeds and collab peers that don't
  know about extensions.

**Canonical order.** Each extension declares a `stage` (`STAGE.shape` = 100, `STAGE.decoration` =
200). The chain is always sorted by stage, then id, so the order the user applies things in doesn't
matter: Mask (shape) always runs before Border (decoration), and the border traces whatever outline
the earlier stages produced (circle, rounded rectangle, or the full rectangle when unmasked).

## 3. Lifecycle

Every action re-renders **from the original through the full chain** (decisions D-X1, D-X2).

| Action                    | What happens                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Apply**                 | Adds the link (or replaces its params) and re-renders the chain from `source`, so we never mask a mask or border a border. Other links are kept. On an element with no chain, the element itself becomes `source`.             |
| **Re-apply** (new preset) | Same as apply.                                                                                                                                                                                                                 |
| **Remove**                | Drops the link and re-renders the rest (removing the mask re-traces the border to the rectangle). Removing the **last** link restores the element from `source` (scaled for any resize since) and clears the intent.           |
| **Stale**                 | The element was changed elsewhere so its output no longer matches (`fileId !== outputFileId`). Nothing is reported as applied, the ids are listed as stale, and Remove leaves the element alone. Apply starts a fresh chain.   |
| **Unreadable**            | A newer stack format, a link from a newer extension version, an unknown extension id, invalid params or a damaged `source`. Reported as stale with the reason; apply and remove are refused so nothing newer gets overwritten. |

The output file id is a hash of the source file, the rendering plan and the chain, so the same chain
on the same original always reuses the existing file (for example removing a border goes back to the
mask-only file without re-rendering).

**Versioning.** The stack format has its own version (`v: 2`), and each link records its
extension's schema version. An extension may declare `migrateParams` to read older link params.

**v1 migration.** Files written before stacking store a single intent object
(`{ ext, v, params, source, outputFileId }`). It is read as a one-link chain, so masked images keep
displaying, report as applied, and can be re-applied or removed. The next apply or remove writes the
v2 stack.

**Source files.** The original image (`source.fileId`) is referenced by no element, so the app
keeps it alive explicitly:

| Path                              | Behaviour                                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `.excalidraw` save / autosave     | `serializeScene` writes every file in `getFiles()`; originals are kept.                                                     |
| Reload / session restore          | `restore()` keeps all files from the document; the component doesn't garbage-collect files.                                 |
| Collab                            | File sync uses `sceneFileIds()` (image `fileId`s plus `extensionReferencedFileIds()`), so originals are sent and requested. |
| PNG export with embedded scene    | Uses Excalidraw's own `serializeAsJSON`, which keeps only files that elements reference: **the original is dropped**.       |
| Stock Excalidraw / excalidraw.com | May drop unreferenced files on save: **the original may be lost**.                                                          |

When the original is missing, the output still renders. The runner skips Re-apply and Remove with
"the original image for <Extension> is missing", and the UI shows that message. Intermediate output
files (for example the mask-only PNG after a border is added) stay in the scene's files; nothing
garbage-collects them.

## 4. Contract

`src/extensions/types.ts` (abridged). Extensions are declarative; the shared pipeline
(`stack.ts`, `pipeline.ts`, `raster.ts`) owns storage, geometry, rasterising and output files.

```ts
interface DesktopExtension<P> {
  id: string; // "mask"
  version: number; // written to link.v
  stage: number; // STAGE.shape | STAGE.decoration
  title: string; // "Mask"
  description?: string; // tooltip / agent description
  appliesTo(el): boolean;
  paramsSchema: JSONSchema; // also the MCP params schema
  presets: { id; label; params: Partial<P> }[]; // UI buttons and MCP preset ids
  defaultPreset?: string; // base params for choices when nothing is applied
  choices?: { param; label; options: { value; label; swatch? }[] }; // e.g. border colour
  normalizeParams(raw): P; // validate + fill defaults; throw a readable Error
  migrateParams?(params, fromVersion): unknown;
  plan?(plan: ImagePlan, params: P): ImagePlan; // change output size / outline (shape stages)
  render?(ctx: RenderTarget, plan: ImagePlan, params: P): void; // paint onto the output
}
```

`ImagePlan` carries the visible source rectangle, the element's scene box, the output size in
pixels and the current **outline** (`rect`, `ellipse` or `roundedRect`). The renderer draws the
source, runs each `render` step in order, and finally clips the output to the outline, so shape
stages only need `plan` and decorations only need `render` (drawing with `outlinePath`).

Rules for an extension:

- Be pure: no Excalidraw API, no network, no element writes. The pipeline sets `customData`, bounds,
  `crop` and files; the runner owns writes, undo and file registration.
- Keep bounds stable when you can; a decoration must stay inside the outline.
- Throw `Error` with a user-readable message. It's shown in the UI and returned to the agent.

Registry: `src/extensions/registry.ts` (`BUILTIN_EXTENSIONS`, sorted by stage).

## 5. Runner, undo and collab

Extensions are asynchronous (decoding and rasterising), so `src/extensions/runner.ts` uses two
phases:

1. `prepareExtension` runs the chain against a snapshot and records each element's `version`. It
   skips elements that don't apply, whose stack is unreadable, that don't carry the extension (for
   remove), or whose original is missing, and catches per-element errors.
2. `mergePrepared` (UI) or `applyPreparedToDraft` (agent) writes results through `newElementWith`,
   but only for elements still at the recorded version. Anything the user edited in the meantime is
   left alone and reported.

- **UI:** `runExtension` calls `addFiles` and then a single `updateScene({ captureUpdate:
IMMEDIATELY })`. Several selected elements become **one undo step**.
- **Agent:** the tools go through the normal agent draft, so the change folds into the turn's single
  undo step and Revert turn works as usual.
- **Collab:** it's an ordinary scene change plus files, so peers receive the output and intent like
  any other edit. Peers without extensions just see the output.

## 6. UI surface

`src/components/ExtensionsBar.tsx` is a small toolbar anchored above the current selection (or below
it near the top edge). For each extension that applies to the selection it shows
`[icon] Title  Preset…  [swatches]  Remove title`, so a masked, bordered image shows both groups. The
active preset (and swatch) is highlighted when every target carries it. Presets and swatches only
set their own params: clicking **Thick** keeps the current border colour, and clicking a colour keeps
the current width (or uses the default preset when no border is applied).
The bar hides in view mode, for collab viewers, and while drawing, typing, dragging, resizing or
rotating. It uses `mousedown` `preventDefault`, so Excalidraw keeps focus and Ctrl/Cmd+Z still
works.

Why this surface: `@excalidraw/excalidraw` 0.18.1 has no prop for adding context-menu items, doesn't
export its command palette, and `renderTopRightUI` isn't selection-aware. A selection-anchored bar is
discoverable, needs no fork, and only appears when it's relevant.

## 7. MCP tools (agent)

The registry generates two tools (`src/extensions/tools.ts`):

| Tool               | Args                                                                           |
| ------------------ | ------------------------------------------------------------------------------ |
| `apply_extension`  | `ids`, `extension` (enum), `preset` (enum) and/or `params`, `expectedRevision` |
| `remove_extension` | `ids`, `extension`, `expectedRevision`                                         |

- There is one generic tool rather than one per extension. Per-extension params schemas are embedded
  as `params.anyOf` (titled by extension id), because Anthropic tool schemas reject top-level
  `oneOf`/`anyOf`. Params are validated at runtime against the chosen extension's `paramsSchema`.
  When both are given, `preset` params are merged under explicit `params`.
- `src/agent/tools.json` must match the generator. `src/extensions/tools.test.ts` fails when it
  drifts; run `npm run extensions:sync-tools` to regenerate it. The Rust server reads tools.json via
  `include_str!`, so no Rust change is needed.
- Both act on one link of the chain: applying a border to a masked image keeps the mask; removing the
  mask keeps the border (re-traced to the rectangle); removing the last link restores the original.
- Reads: `get_scene_summary` rows include `ext` (every applied extension → params) and `extStale`,
  and `get_elements` returns an `extensions` map.
- Both tools work inside `apply_ops`. Limitation: an extension op can't target an element that an
  earlier op in the same batch changed, because extensions are prepared against the scene before the
  batch runs. The batch fails atomically with a clear error; split it into two calls.
- Viewer tabs refuse them like every other edit tool.

## 8. Security

Extensions are **built-in modules compiled into the app**. There is no plugin loading, no `eval`,
no remote code, and nothing in a document can make the app run code. A document's `customData` is
data only: a stack with an unknown `ext` id is left untouched, and params are schema-validated
before use. Extensions run
entirely in the webview, make no network calls, and need no Tauri capability or CSP change.

## 9. Extension: Mask

- **Applies to:** image elements with a loaded file.
- **Params:** `{ shape: "circle" | "roundedRect", radius?: 0–50 }`. `radius` is a percentage of the
  shorter side (default 15).
- **Presets / UI:** **Circle**, **Rounded rectangle** (radius 15), and **Remove mask**.
- **Output:** a PNG (longest side ≤ 1024 px; SVG sources are rasterised) with the shape baked into
  its alpha channel, respecting the image's current crop. The element's box is fitted to the masked
  shape and `crop` is cleared.
- **Source:** the original `fileId`, bounds and crop, plus the size right after masking (so a later
  resize carries back onto the original when the mask is removed).
- **Stage:** shape. Changes the outline to an ellipse or rounded rectangle, so later stages (Border)
  follow it.
- **Stale** when the element's `fileId` is no longer `outputFileId` (for example the image was
  replaced).

## 10. Extension: Border

Excalidraw 0.18.1 never renders `strokeColor` / `strokeWidth` on image elements
(`generateElementShape` returns no shape for images and the properties panel hides stroke), so the
border is baked into the output PNG.

- **Applies to:** image elements with a loaded file.
- **Params:** `{ width?: 0.5–100, color?: "#rgb" | "#rrggbb", opacity?: 0–100 }`, defaults
  `4`, `#868e96` (a mid gray that reads on both light and dark canvases) and `100`. `width` is in
  scene units at the element's size when applied.
- **Presets / UI:** **Thin** (2), **Medium** (4), **Thick** (8), colour swatches (Gray, Black, White,
  Blue, Red), and **Remove border**.
- **Stage:** decoration. Strokes the current outline (rectangle, circle or rounded rectangle)
  **inside** the edge, antialiased, so element bounds never change. The stroke is capped at half the
  shorter side.
- **Resize:** the border is part of the bitmap, so it scales with the element until re-applied
  (re-applying re-renders at the new size). Flips need no special handling because every outline is
  symmetric.

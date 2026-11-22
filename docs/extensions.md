# Desktop extensions

> Design contract for features the app adds on top of Excalidraw **without changing the
> `.excalidraw` format**. Code: `src/extensions/`. Built-in extensions: image Grayscale, Tint, Mask, Border and Shadow, stackable.

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

**Canonical order.** Each extension declares a `stage`. The chain is always sorted by stage, then
id, so the order the user applies things in doesn't matter:

| Stage              | Value | Extensions (stage)        | Step                                                     |
| ------------------ | ----- | ------------------------- | -------------------------------------------------------- |
| `STAGE.color`      | 50    | Grayscale (50), Tint (60) | `pixels`: recolour the source pixels                     |
| `STAGE.shape`      | 100   | Mask                      | `plan`: change the outline / output size                 |
| `STAGE.decoration` | 200   | Border                    | `render`: paint inside the outline                       |
| `STAGE.effect`     | 300   | Shadow                    | `plan` (`pad`) + `renderBehind`: paint outside the image |

Colour stages run on the original pixels, so the border is never recoloured. The border traces
whatever outline the earlier stages produced (circle, rounded rectangle, or the full rectangle when
unmasked), and the shadow follows the finished, masked and bordered shape.

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

| Path                              | Behaviour                                                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `.excalidraw` save / autosave     | Saves `referencedFiles()`: files used by live elements via `sceneFileIds()`, so originals are kept and stale outputs pruned. |
| Reload / session restore          | `restore()` keeps all files from the document; the component doesn't garbage-collect files.                                  |
| Collab                            | File sync uses `sceneFileIds()` (image `fileId`s plus `extensionReferencedFileIds()`), so originals are sent and requested.  |
| PNG export with embedded scene    | Uses Excalidraw's own `serializeAsJSON`, which keeps only files that elements reference: **the original is dropped**.        |
| Stock Excalidraw / excalidraw.com | May drop unreferenced files on save: **the original may be lost**.                                                           |

When the original is missing, the output still renders. The runner skips Re-apply and Remove with
"the original image for <Extension> is missing", and the UI shows that message. Superseded output
files (for example the PNG from a previous border colour) stay in memory so undo works, but are
dropped on the next save.

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
  plan?(plan: ImagePlan, params: P): ImagePlan; // change output size / outline / pad
  pixels?(img: PixelBuffer, plan: ImagePlan, params: P): void; // edit RGBA in place (colour stages)
  render?(ctx: RenderTarget, plan: ImagePlan, params: P): void; // paint onto the output
  renderBehind?(out: PixelBuffer, content: PixelBuffer, plan: ImagePlan, params: P): void; // effects
}
```

`ImagePlan` carries the visible source rectangle, the element's scene box, the output size in
pixels and the current **outline** (`rect`, `ellipse` or `roundedRect`). The renderer draws the
source, runs each `render` step in order, and finally clips the output to the outline, so shape
stages only need `plan` and decorations only need `render` (drawing with `outlinePath`).
`pixels` steps run in chain order with `render` steps on unpremultiplied RGBA. After clipping,
`renderBehind` steps paint into a padded bitmap underneath the finished content, which is then
composited over them. **Never use `ctx.filter`**: WKWebView doesn't implement it, so blurs and
colour maths are done by hand in `pixels.ts` (three-pass box blur, Rec. 709 luma, `compositeOver`).

**Drawing outside the image (`plan.pad`).** An effect that needs room outside the content returns
`plan.pad` (`{ left, top, right, bottom }` in integer output pixels, bitmap orientation; `plan.flip`
carries the element's mirroring). The pipeline grows the output bitmap by the pad and grows the
element box by the same margin in scene units, moving `x`/`y` up and left by the left/top margin.
The content pixels therefore land exactly where the image was, so the visible image never shifts.
The stack stores the margin as `source.inset` (scene units at the applied size) and records the
padded size as `appliedWidth/Height`; re-rendering and remove strip the inset first (`baseOf`) to
get the content box back, so restoring the original lands on the original bounds even after a
resize. `outputFileId` only hashes pad and flip when a pad is present, so every output written
before effects existed keeps its id, and chain v2 documents load unchanged (`inset` is optional).

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

**Derived sync (experimental).** Features where one element drives others (components, named
styles, smart containers) need a different path: a "reactor" that re-derives targets with
`captureUpdate: NEVER` whenever a source changes locally. The Wave 1 spike validated undo/redo,
drag performance, collab convergence, text re-measure and duplicate→instance against the real
0.18.1 editor. See [reactor-spike.md](reactor-spike.md) for the findings and the recommended
Components v1 design. The prototype in `src/extensions/reactor/` is not wired into the app.

## 6. UI surface

Image controls live **inside Excalidraw's own properties panel** (the left "selected shape actions"
island), so an image gets the same Stroke treatment as native shapes.
`src/components/imageProps/ImagePropertiesPanel.tsx` renders a React portal into the panel when the
selection contains image elements:

- **Stroke** — a colour picker that mirrors the native one
  (`src/components/imageProps/StrokeColorPicker.tsx`: the five top picks, the transparent "none"
  swatch, and a popover with the open-color palette, shades 1–5, the same hotkeys and a hex input);
  then **Stroke width** (thin / bold / extra bold), **Stroke style** (solid / dashed / dotted) and
  **Sloppiness** (architect / artist / cartoonist) with Excalidraw's icons. Width, style and
  sloppiness only show once a border is applied; picking a colour applies one, transparent removes
  it. Each choice patches only its own param (`patchParams` in `groups.ts`), keeping the others.
- **Mask** — No mask / Circle / Rounded rectangle.
- **Grayscale** — an amount slider (0–100 %; 0 removes it).
- **Tint** — the same colour picker (`image-tint-*` test ids; transparent removes it), then a
  **strength** slider once applied.
- **Shadow** — the colour picker (`image-shadow-*`), then **opacity**, **blur** (0–50 in the UI,
  0–100 for the agent) and **X / Y offset** (−100–100) sliders once applied.

Sliders (`RangeControl.tsx`) are native ranges styled like Excalidraw's opacity slider. Dragging
previews nothing; the release (pointer-up or key-up) commits one `runExtension` call, so one undo
step. The effect sections are one self-contained component, `EffectsSection.tsx`, taking the panel
host's image-section props (`groups`, `onlyImages`, `label`, `busy`, `run`).

**Panel host.** The portal is generic: `src/components/propertiesPanel/PropertiesPanelHost.tsx`
hosts any registered `PanelSection` (`panel.ts`: `id`, `slot` top/bottom, `testId`, a cheap
`view(ctx)` that returns JSON-serialisable view data or `null` to hide, a strip `title`, `icon`,
`summary(view)` and optional `primary(view)`, and an optional `Component` body). Top sections form
the **panel strip** (FR-63): one compact row each at the very top of the panel — icon, title,
one-line summary, inline primary action — and clicking a row expands its body; one row is open at a
time and the choice is remembered (`panelStripStore`, setting `panelStripOpen`). `sections.ts` lists
them in order: Component, Properties, **Image** (these controls), Anchors, Container, Style, then
**Data** for any selection (key/value rows, shared keys for a mixed selection, Copy data as CSV). Image sections are registered by appending `{ id, extensions, Component }` to
`IMAGE_SECTIONS` in `src/components/imageProps/registry.ts`; components get `ImageSectionProps`
(`groups`, `onlyImages`, `label`, `busy`, `run`).

With a mixed selection the legends read "Image stroke" / "Image mask" because they only affect the
images. The sections are hidden in view and zen mode, for collab viewers, and while drawing, typing,
dragging, resizing or rotating. Every click is one `runExtension` call (one undo step); buttons use
`mousedown` `preventDefault`, so Excalidraw keeps focus and Ctrl/Cmd+Z still works. Because the
sections are portals outside Excalidraw's React tree, its container `onKeyDown` never sees their key
events: `propertiesPanel/keyboard.ts` re-dispatches Ctrl/Cmd keydowns from non-text controls onto
`.excalidraw-container`, and moves focus back there when it drops to `<body>` (an input committed on
Enter, a disabled or removed control). Text inputs keep typing and their own text undo.

**DOM dependency.** 0.18.1 has no API for adding panel sections and doesn't export its colour or
stroke pickers, so the host attaches to `PANEL_SELECTOR` — `.App-menu__left .panelColumn` on
desktop and `.App-mobile-menu .panelColumn` for the mobile properties sheet — strip rows go before
the panel's first child (the stroke slot that is empty for images), and reuses Excalidraw's own class
names (`buttonList`, `color-picker__*`, `Island`) so it matches both themes. A `MutationObserver`
re-attaches it when Excalidraw remounts the panel. When no panel is in the DOM (the mobile layout
with its sheet closed, or a future upstream change), the same sections render in a small docked
`Island` (`data-testid=props-dock`, sections `<testId>-dock`, e.g. `image-props-dock`) at the top
left instead. `e2e/extensions.spec.ts` and
`e2e/shape-data-anchors.spec.ts` pin this contract: re-run them on every `@excalidraw/excalidraw`
bump.

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
- **Presets / UI:** **Circle**, **Rounded rectangle** (radius 15), and **No mask** (removes it).
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
- **Params (v2):** `{ width?: 0.5–100, color?: "#rgb" | "#rrggbb", opacity?: 0–100, style?:
"solid" | "dashed" | "dotted", roughness?: 0 | 1 | 2 }`, defaults `2`, `#868e96` (a mid gray that
  reads on both light and dark canvases), `100`, `"solid"` and `0`. `width` is in scene units at
  the element's size when applied. v1 intents (no style/roughness) migrate to solid architect.
- **Presets / UI:** **Thin** (1), **Bold** (2), **Extra bold** (4) — Excalidraw's own stroke widths
  — plus the stroke colour picker, style and sloppiness (§6). Transparent removes the border.
- **Rendering:** solid architect strokes are a plain canvas stroke. Dashed, dotted or sloppy borders
  are drawn with **roughjs** (pinned to the version Excalidraw uses) along the same outline, with
  Excalidraw's dash arrays and roughness tuning, seeded from `element.seed` so re-renders are
  identical and output file ids stay deterministic.
- **Stage:** decoration. Strokes the current outline (rectangle, circle or rounded rectangle)
  **inside** the edge, antialiased, so element bounds never change. The stroke is capped at half the
  shorter side.
- **Resize:** the border is part of the bitmap, so it scales with the element until re-applied
  (re-applying re-renders at the new size). Flips need no special handling because every outline is
  symmetric.

## 11. Extension: Grayscale

- **Applies to:** image elements with a loaded file.
- **Params:** `{ amount: 0–100 }` (%; default 100), like CSS `grayscale()`: each pixel is mixed
  towards its Rec. 709 luma by `amount`.
- **Presets / UI:** **Grayscale** (100); the panel slider sets any amount, and 0 removes it.
- **Stage:** colour (50). Runs on the source pixels before tint, mask and border, so bounds never
  change and the border keeps its colour.

## 12. Extension: Tint

- **Applies to:** image elements with a loaded file.
- **Params:** `{ color: "#rgb" | "#rrggbb", strength: 0–100 }`, defaults `#1971c2` and `50`. Each
  pixel's luma is mapped onto a black → colour → white ramp (so shading and highlights survive even
  at 100 %), then mixed with the original by `strength`. Alpha is unchanged.
- **Presets / UI:** **Tint** (the defaults); the colour picker applies it and keeps the strength,
  and transparent removes it.
- **Stage:** colour (60), after grayscale (grayscale then tint gives a duotone) and before the mask.

## 13. Extension: Shadow

- **Applies to:** image elements with a loaded file.
- **Params:** `{ offsetX, offsetY: −100–100, blur: 0–100, color, opacity: 0–100 }` in scene units at
  the image's size when applied; defaults `6`, `6`, `8`, `#000000`, `35`.
- **Presets / UI:** **Soft** (0, 4, blur 16, 25 %), **Drop** (the defaults), **Hard** (6, 6, blur 0,
  60 %). In the panel, picking a colour applies the defaults with that colour; transparent removes it.
- **Rendering:** the finished content's alpha (after mask and border) is offset, blurred with a
  three-pass box blur (≈ Gaussian), tinted and drawn underneath with `compositeOver`, all by hand.
  Seeded file ids keep output deterministic.
- **Stage:** effect (300), last. `plan` asks for exactly the margin the offset blur needs
  (`plan.pad`); see §4 for how bounds grow without moving the image.
- **Caveats:**
  - The element's bounds include the shadow margin, so selection, snapping and arrow binding use
    the padded box.
  - The offset is baked into the bitmap: flipping the element after applying mirrors the shadow
    until it is re-applied (re-applying uses the current flip).
  - The padded bitmap may exceed the 1024 px output cap by the margin.
  - As for every stage that swaps the element's file, Excalidraw draws its grey loading placeholder
    at the new bounds for a frame or two.

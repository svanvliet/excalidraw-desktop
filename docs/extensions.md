# Desktop extensions

> Design contract for features the app adds on top of Excalidraw **without changing the
> `.excalidraw` format**. Code: `src/extensions/`. First extension: image mask.

## 1. Problem

Some features the user wants (masking an image to a circle, for example) aren't in Excalidraw's
schema. We depend on `@excalidraw/excalidraw` from npm and never fork it (CLAUDE.md § 8), so we can't
add element types or renderer features. We also want the same feature for people and for the AI
agent: the agent can only do what the UI can, and vice versa.

## 2. Core idea: intent plus standard output

An extension is a built-in module that turns **intent** into **standard Excalidraw output**:

- **Intent** is stored on the element in `element.customData.excalidrawDesktop` (`EXT_KEY`):

  ```jsonc
  {
    "ext": "mask",          // extension id
    "v": 1,                 // extension schema version
    "params": { "shape": "circle" },
    "source": { "fileId": "…", "x": 0, "y": 0, "width": 640, "height": 480, "crop": null, … },
    "outputFileId": "…"     // the file this intent produced
  }
  ```

  `customData` is part of the published schema. Excalidraw persists it, syncs it in collab and copies
  it on paste, but otherwise ignores it.

- **Output** is ordinary element fields plus `BinaryFiles` (for example a PNG with the mask baked
  into its alpha channel). Because of that, the drawing renders identically in stock Excalidraw,
  excalidraw.com, exports, PNG embeds and collab peers that don't know about extensions.

One element carries at most one extension intent at a time.

## 3. Lifecycle

| Action                    | What happens                                                                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Apply**                 | The extension derives output from the element (or, if already applied, from `source`, so we never mask a mask) and writes intent.                                                                                                                                                                |
| **Re-apply** (new preset) | Same as apply; derives from `source` again.                                                                                                                                                                                                                                                      |
| **Remove**                | Restores the element from `source` and clears the intent.                                                                                                                                                                                                                                        |
| **Stale**                 | The element was changed elsewhere so its output no longer matches the intent (for the mask: `fileId !== outputFileId`). `getIntent` returns `null`, the UI shows the extension as not applied, and Remove leaves the element alone. Applying again treats the current element as a fresh source. |

**Versioning.** `v` is the extension's schema version. A newer version of an extension must still
read older intents (and may migrate them when it re-applies). If a future version changes the
`source` shape incompatibly, older apps must treat it as not applied (`getIntent` returns `null` when
`source` doesn't validate); the standard output still renders either way.

**Source files.** Files an intent depends on beyond the element's own `fileId` (the unmasked
original) MUST be named `source.fileId` or `source.fileIds`. No element references them, so the app
keeps them alive explicitly:

| Path                              | Behaviour                                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `.excalidraw` save / autosave     | `serializeScene` writes every file in `getFiles()`; originals are kept.                                                     |
| Reload / session restore          | `restore()` keeps all files from the document; the component doesn't garbage-collect files.                                 |
| Collab                            | File sync uses `sceneFileIds()` (image `fileId`s plus `extensionReferencedFileIds()`), so originals are sent and requested. |
| PNG export with embedded scene    | Uses Excalidraw's own `serializeAsJSON`, which keeps only files that elements reference: **the original is dropped**.       |
| Stock Excalidraw / excalidraw.com | May drop unreferenced files on save: **the original may be lost**.                                                          |

When the original is missing, the masked output still renders. The runner skips Re-apply and Remove
with "the original image for Mask is missing", and the UI shows that message.

## 4. Contract

`src/extensions/types.ts` (abridged):

```ts
interface DesktopExtension<P> {
  id: string; // "mask"
  version: number; // written to intent.v
  title: string; // "Mask"
  description?: string; // tooltip / agent description
  appliesTo(el): boolean;
  paramsSchema: JSONSchema; // also the MCP params schema
  presets: { id; label; params: P }[]; // UI buttons and MCP preset ids
  getIntent(el): ExtensionIntent | null; // null when not applied OR stale
  apply(el, params, ctx): Promise<{ element; files }>;
  remove(el, ctx): Promise<{ element; files }>;
}
```

Rules for an extension:

- Keep the element `id`. Set or clear `customData[EXT_KEY]` yourself and preserve other `customData`
  keys.
- `apply` must derive from `source` when the element is already applied, and treat a stale element as
  a fresh source.
- Be deterministic where possible: the mask names its output file from a hash of source + params, so
  re-applying the same preset reuses the existing file.
- Throw `Error` with a user-readable message. It's shown in the UI and returned to the agent.
- Don't call the Excalidraw API. The runner owns writes, undo and file registration.

Registry: `src/extensions/registry.ts` (`BUILTIN_EXTENSIONS`).

## 5. Runner, undo and collab

Extensions are asynchronous (decoding and rasterising), so `src/extensions/runner.ts` uses two
phases:

1. `prepareExtension` runs the extension against a snapshot and records each element's `version`.
   It skips elements that don't apply, aren't applied (for remove), or whose original is missing, and
   catches per-element errors.
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
`[icon] Title  Preset…  Remove title`. The active preset is highlighted when every target carries it.
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
- Reads: `get_scene_summary` rows include `ext` (applied extension → params) and `extStale`, and
  `get_elements` returns an `extensions` map.
- Both tools work inside `apply_ops`. Limitation: an extension op can't target an element that an
  earlier op in the same batch changed, because extensions are prepared against the scene before the
  batch runs. The batch fails atomically with a clear error; split it into two calls.
- Viewer tabs refuse them like every other edit tool.

## 8. Security

Extensions are **built-in modules compiled into the app**. There is no plugin loading, no `eval`,
no remote code, and nothing in a document can make the app run code. A document's `customData` is
data only: an unknown `ext` id is ignored, and params are schema-validated before use. Extensions run
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
- **Stale** when the element's `fileId` is no longer `outputFileId` (for example the image was
  replaced).

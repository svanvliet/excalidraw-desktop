import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_EXTENSIONS } from "./registry";
import { EXTENSION_TOOL_NAMES, extensionToolDefs } from "./tools";
import { stubExtension } from "./testStub";

const TOOLS_JSON = resolve(__dirname, "../agent/tools.json");

describe("extension MCP tools", () => {
  it("src/agent/tools.json matches the registry (run `npm run extensions:sync-tools`)", () => {
    const doc = JSON.parse(readFileSync(TOOLS_JSON, "utf8"));
    const expected = extensionToolDefs(BUILTIN_EXTENSIONS);
    if (process.env.UPDATE_EXTENSION_TOOLS) {
      const others = doc.tools.filter(
        (t: { name: string }) => !(EXTENSION_TOOL_NAMES as readonly string[]).includes(t.name),
      );
      doc.tools = [...others, ...expected];
      writeFileSync(TOOLS_JSON, `${JSON.stringify(doc, null, 2)}\n`);
    }
    for (const def of expected) {
      expect(doc.tools.find((t: { name: string }) => t.name === def.name)).toEqual(def);
    }
  });

  it("embeds each extension's id, presets and params schema", () => {
    const [apply, remove] = extensionToolDefs([stubExtension]);
    const props = apply.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.extension.enum).toEqual(["stub"]);
    expect(props.preset.enum).toEqual(["red", "blue"]);
    expect(props.params.anyOf).toEqual([{ title: "stub", ...stubExtension.paramsSchema }]);
    expect(apply.description).toContain("stub: Stub; presets red (Red), blue (Blue).");
    expect(Object.keys(remove.inputSchema.properties as object)).toEqual([
      "tabId",
      "expectedRevision",
      "ids",
      "extension",
    ]);
  });
});

import type { TranscriptItem } from "../../stores/agentStore";

export type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

export type TranscriptEntry =
  | { kind: "item"; item: TranscriptItem }
  | { kind: "tools"; items: ToolItem[] };

/** Folds each run of consecutive tool calls into one group, keeping flow order. */
export function groupTranscript(items: TranscriptItem[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (item.kind === "tool") {
      if (last?.kind === "tools") last.items.push(item);
      else out.push({ kind: "tools", items: [item] });
    } else {
      out.push({ kind: "item", item });
    }
  }
  return out;
}

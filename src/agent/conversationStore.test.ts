import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { TranscriptItem } from "../stores/agentStore";
import {
  docKey,
  trimForStorage,
  titleFrom,
  loadConversations,
  saveConversations,
  flushConversations,
  renameConversationsKey,
  deleteConversationsKey,
  loadKnownModels,
  saveKnownModels,
  MAX_STORED_ITEMS,
  MAX_TOOL_TEXT,
  __setConversationStoreForTest,
  type ConversationRecord,
  type PersistedKV,
} from "./conversationStore";

class FakeStore implements PersistedKV {
  data = new Map<string, unknown>();
  saves = 0;
  async get<T>(key: string): Promise<T | undefined> {
    const v = this.data.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async save(): Promise<void> {
    this.saves += 1;
  }
}

function rec(id: string, updatedAt: number, items: TranscriptItem[] = []): ConversationRecord {
  return {
    id,
    engine: "copilot",
    engineSessionId: `eng-${id}`,
    title: id,
    model: null,
    attachedFolder: null,
    createdAt: 0,
    updatedAt,
    items,
    usage: { inputTokens: null, outputTokens: null, premiumRequests: null },
  };
}

const user = (n: number): TranscriptItem => ({ kind: "user", id: `u${n}`, text: `msg ${n}` });

function tool(input: unknown, output: string | null): TranscriptItem {
  return {
    kind: "tool",
    id: "t1",
    turnId: "turn",
    name: "x",
    title: null,
    source: "canvas",
    status: "completed",
    input,
    output,
  } as TranscriptItem;
}

let store: FakeStore;
beforeEach(() => {
  store = new FakeStore();
  __setConversationStoreForTest(store);
});
afterEach(() => {
  vi.useRealTimers();
  __setConversationStoreForTest(null);
});

describe("docKey", () => {
  it("uses the path, or a tab-scoped key for untitled tabs", () => {
    expect(docKey({ id: "a", path: "/x.excalidraw" })).toBe("/x.excalidraw");
    expect(docKey({ id: "a", path: null })).toBe("tab:a");
  });
});

describe("trimForStorage", () => {
  it("keeps only the last MAX_STORED_ITEMS items", () => {
    const items = Array.from({ length: MAX_STORED_ITEMS + 5 }, (_, i) => user(i));
    const out = trimForStorage(rec("c", 1, items));
    expect(out.items).toHaveLength(MAX_STORED_ITEMS);
    expect(out.items[0]).toEqual(user(5));
  });

  it("truncates long tool output and input, leaves text untouched", () => {
    const longText = "y".repeat(MAX_TOOL_TEXT + 10);
    const out = trimForStorage(
      rec("c", 1, [
        tool({ big: "x".repeat(MAX_TOOL_TEXT) }, "o".repeat(MAX_TOOL_TEXT + 1)),
        {
          kind: "user",
          id: "u",
          text: longText,
        },
      ]),
    );
    const t = out.items[0] as Extract<TranscriptItem, { kind: "tool" }>;
    expect(t.output).toHaveLength(MAX_TOOL_TEXT + 1);
    expect(t.output?.endsWith("…")).toBe(true);
    expect(typeof t.input).toBe("string");
    expect((t.input as string).length).toBe(MAX_TOOL_TEXT + 1);
    expect((out.items[1] as { text: string }).text).toBe(longText);
  });

  it("keeps small tool input as-is", () => {
    const out = trimForStorage(rec("c", 1, [tool({ a: 1 }, "ok")]));
    expect((out.items[0] as { input: unknown }).input).toEqual({ a: 1 });
  });

  it("stores pending permissions as expired", () => {
    const perm = (decision: null | "allowOnce"): TranscriptItem =>
      ({
        kind: "permission",
        id: "p",
        turnId: "t",
        toolName: "x",
        title: "x",
        detail: null,
        decision,
      }) as TranscriptItem;
    const out = trimForStorage(rec("c", 1, [perm(null), perm("allowOnce")]));
    expect((out.items[0] as { decision: unknown }).decision).toBe("expired");
    expect((out.items[1] as { decision: unknown }).decision).toBe("allowOnce");
  });
});

describe("titleFrom", () => {
  it("uses the whitespace-collapsed first line", () => {
    expect(titleFrom("  draw   a\tcat \nand more")).toBe("draw a cat");
  });
  it("caps at 60 chars with an ellipsis", () => {
    const t = titleFrom("a".repeat(100));
    expect(t).toHaveLength(60);
    expect(t.endsWith("…")).toBe(true);
  });
});

describe("save / load", () => {
  it("debounces saves and flush writes them", async () => {
    vi.useFakeTimers();
    saveConversations("k", { activeId: "a", list: [rec("a", 1)] });
    saveConversations("k", { activeId: "a", list: [rec("a", 2)] });
    expect(store.saves).toBe(0);
    // Pending saves are visible to readers before they hit disk.
    expect((await loadConversations("k"))?.list[0].updatedAt).toBe(2);
    await flushConversations();
    expect(store.saves).toBe(1);
    expect(store.data.get("v")).toBe(1);
    expect((await loadConversations("k"))?.list[0].updatedAt).toBe(2);
  });

  it("writes after the debounce elapses", async () => {
    vi.useFakeTimers();
    saveConversations("k", { activeId: null, list: [rec("a", 1)] });
    await vi.advanceTimersByTimeAsync(499);
    expect(store.saves).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await flushConversations();
    expect(store.saves).toBe(1);
  });

  it("caps the list at the 50 most recently updated", async () => {
    const list = Array.from({ length: 60 }, (_, i) => rec(`c${i}`, i));
    saveConversations("k", { activeId: "c0", list });
    await flushConversations();
    const loaded = await loadConversations("k");
    expect(loaded?.list).toHaveLength(50);
    expect(loaded?.list[0].id).toBe("c59");
    expect(loaded?.list.some((c) => c.id === "c9")).toBe(false);
    expect(loaded?.activeId).toBeNull();
  });

  it("returns null for unknown keys and deletes keys", async () => {
    expect(await loadConversations("nope")).toBeNull();
    saveConversations("k", { activeId: null, list: [rec("a", 1)] });
    await flushConversations();
    await deleteConversationsKey("k");
    expect(await loadConversations("k")).toBeNull();
  });
});

describe("renameConversationsKey", () => {
  it("moves the entry when the target is empty", async () => {
    saveConversations("tab:1", { activeId: "a", list: [rec("a", 1)] });
    await renameConversationsKey("tab:1", "/p.excalidraw");
    expect(await loadConversations("tab:1")).toBeNull();
    expect((await loadConversations("/p.excalidraw"))?.activeId).toBe("a");
  });

  it("merges into an existing target, deduping by id", async () => {
    saveConversations("/p", { activeId: "b", list: [rec("a", 1), rec("b", 2)] });
    saveConversations("tab:1", { activeId: "c", list: [rec("a", 5), rec("c", 3)] });
    await renameConversationsKey("tab:1", "/p");
    const merged = await loadConversations("/p");
    expect(merged?.list.map((c) => c.id)).toEqual(["a", "c", "b"]);
    expect(merged?.list[0].updatedAt).toBe(5);
    expect(merged?.activeId).toBe("c");
  });
});

describe("known models", () => {
  it("round-trips per engine", async () => {
    await saveKnownModels("copilot", [{ id: "gpt", name: "GPT" }]);
    await saveKnownModels("claude", [{ id: "opus", name: null }]);
    expect(await loadKnownModels("copilot")).toEqual([{ id: "gpt", name: "GPT" }]);
    expect(await loadKnownModels("claude")).toEqual([{ id: "opus", name: null }]);
    expect(await loadKnownModels("codex")).toEqual([]);
  });
});

describe("graceful failure", () => {
  it("never throws when the store fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken: PersistedKV = {
      get: () => Promise.reject(new Error("boom")),
      set: () => Promise.reject(new Error("boom")),
      save: () => Promise.reject(new Error("boom")),
    };
    __setConversationStoreForTest(broken);
    expect(await loadConversations("k")).toBeNull();
    expect(await loadKnownModels("copilot")).toEqual([]);
    saveConversations("k", { activeId: null, list: [rec("a", 1)] });
    await expect(flushConversations()).resolves.toBeUndefined();
    await expect(renameConversationsKey("k", "j")).resolves.toBeUndefined();
    await expect(deleteConversationsKey("k")).resolves.toBeUndefined();
    await expect(saveKnownModels("copilot", [])).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

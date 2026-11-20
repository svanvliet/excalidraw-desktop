/**
 * Persisted AI conversation index, per drawing.
 *
 * Hybrid persistence: the engine keeps the real session context (resumed via
 * its engine session id); we keep a small index per document — engine,
 * engine session id, title, model, attached folder, timestamps and a trimmed
 * transcript copy for display — plus the last-known model list per engine.
 *
 * Layout of `agent-conversations.json`:
 *   v      -> STORE_VERSION
 *   docs   -> Record<docKey, ConversationIndex>
 *   models -> Partial<Record<EngineKind, ModelOption[]>>
 *
 * All I/O is best-effort: failures are logged and never thrown to the UI.
 */
import { LazyStore } from "@tauri-apps/plugin-store";

import type { EngineKind, ModelOption, Usage } from "./types";
import type { TranscriptItem } from "../stores/agentStore";
import { log } from "../lib/logger";
import { storeFile } from "../lib/storeFile";

export interface ConversationRecord {
  id: string;
  engine: EngineKind;
  engineSessionId: string | null;
  title: string;
  model: string | null;
  attachedFolder: string | null;
  createdAt: number;
  updatedAt: number;
  items: TranscriptItem[];
  usage: Usage;
}

export interface ConversationIndex {
  activeId: string | null;
  list: ConversationRecord[];
}

export const MAX_STORED_ITEMS = 300;
export const MAX_TOOL_TEXT = 4000;
const MAX_CONVERSATIONS = 50;
const SAVE_DEBOUNCE_MS = 500;
const MAX_TITLE = 60;

const STORE_FILE = "agent-conversations.json";
const STORE_VERSION = 1;
const KEY_VERSION = "v";
const KEY_DOCS = "docs";
const KEY_MODELS = "models";

type DocsMap = Record<string, ConversationIndex>;
type ModelsMap = Partial<Record<EngineKind, ModelOption[]>>;

export interface PersistedKV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
}

let storeSingleton: PersistedKV | null = null;
async function getStore(): Promise<PersistedKV> {
  if (!storeSingleton) {
    storeSingleton = new LazyStore(await storeFile(STORE_FILE)) as unknown as PersistedKV;
  }
  return storeSingleton;
}

/** For tests only — inject a fake store (also drops pending saves). */
export function __setConversationStoreForTest(store: PersistedKV | null): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  writeChain = Promise.resolve();
  storeSingleton = store;
}

export function docKey(tab: { id: string; path: string | null }): string {
  return tab.path ?? `tab:${tab.id}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function trimItem(item: TranscriptItem): TranscriptItem {
  if (item.kind === "tool") {
    let input = item.input;
    if (input !== undefined && typeof input !== "string") {
      let json: string | undefined;
      try {
        json = JSON.stringify(input);
      } catch {
        json = "[unserializable]";
        input = json;
      }
      if (json !== undefined && json.length > MAX_TOOL_TEXT) input = truncate(json, MAX_TOOL_TEXT);
    } else if (typeof input === "string" && input.length > MAX_TOOL_TEXT) {
      input = truncate(input, MAX_TOOL_TEXT);
    }
    const output = item.output === null ? null : truncate(item.output, MAX_TOOL_TEXT);
    return { ...item, input, output };
  }
  if (item.kind === "permission" && item.decision === null) {
    return { ...item, decision: "expired" };
  }
  return item;
}

export function trimForStorage(r: ConversationRecord): ConversationRecord {
  const items = r.items.length > MAX_STORED_ITEMS ? r.items.slice(-MAX_STORED_ITEMS) : r.items;
  return { ...r, items: items.map(trimItem) };
}

export function titleFrom(text: string): string {
  const firstLine = text.trim().split(/\r?\n/)[0] ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_TITLE ? `${collapsed.slice(0, MAX_TITLE - 1)}…` : collapsed;
}

function normalizeIndex(index: ConversationIndex): ConversationIndex {
  const list = [...index.list]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CONVERSATIONS)
    .map(trimForStorage);
  const activeId =
    index.activeId && list.some((c) => c.id === index.activeId) ? index.activeId : null;
  return { activeId, list };
}

function isIndex(v: unknown): v is ConversationIndex {
  return typeof v === "object" && v !== null && Array.isArray((v as ConversationIndex).list);
}

async function readDocs(store: PersistedKV): Promise<DocsMap> {
  const docs = await store.get<DocsMap>(KEY_DOCS);
  return docs && typeof docs === "object" ? { ...docs } : {};
}

// Serialize read-modify-write cycles so concurrent writers can't drop updates.
let writeChain: Promise<void> = Promise.resolve();
function enqueueWrite(label: string, fn: (store: PersistedKV) => Promise<void>): Promise<void> {
  const run = writeChain.then(async () => {
    try {
      const store = await getStore();
      await fn(store);
      await store.set(KEY_VERSION, STORE_VERSION);
      await store.save();
    } catch (e) {
      log.warn(`conversationStore: ${label} failed`, e);
    }
  });
  writeChain = run;
  return run;
}

interface PendingSave {
  index: ConversationIndex;
  timer: ReturnType<typeof setTimeout>;
}
const pending = new Map<string, PendingSave>();

function writeDoc(key: string, index: ConversationIndex): Promise<void> {
  return enqueueWrite(`save ${key}`, async (store) => {
    const docs = await readDocs(store);
    docs[key] = index;
    await store.set(KEY_DOCS, docs);
  });
}

function takePending(key: string): ConversationIndex | null {
  const p = pending.get(key);
  if (!p) return null;
  clearTimeout(p.timer);
  pending.delete(key);
  return p.index;
}

export async function loadConversations(key: string): Promise<ConversationIndex | null> {
  const unsaved = pending.get(key);
  if (unsaved) return unsaved.index;
  try {
    await writeChain;
    const store = await getStore();
    const docs = await readDocs(store);
    const entry = docs[key];
    return isIndex(entry) ? entry : null;
  } catch (e) {
    log.warn(`conversationStore: load ${key} failed`, e);
    return null;
  }
}

export function saveConversations(key: string, index: ConversationIndex): void {
  let normalized: ConversationIndex;
  try {
    normalized = normalizeIndex(index);
  } catch (e) {
    log.warn(`conversationStore: normalize ${key} failed`, e);
    return;
  }
  const prev = pending.get(key);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    const idx = takePending(key);
    if (idx) void writeDoc(key, idx);
  }, SAVE_DEBOUNCE_MS);
  pending.set(key, { index: normalized, timer });
}

export async function flushConversations(): Promise<void> {
  const keys = [...pending.keys()];
  for (const key of keys) {
    const idx = takePending(key);
    if (idx) void writeDoc(key, idx);
  }
  await writeChain;
}

export async function renameConversationsKey(from: string, to: string): Promise<void> {
  if (from === to) return;
  await flushConversations();
  await enqueueWrite(`rename ${from} -> ${to}`, async (store) => {
    const docs = await readDocs(store);
    const src = docs[from];
    if (!isIndex(src)) return;
    const dst = docs[to];
    let merged: ConversationIndex = src;
    if (isIndex(dst)) {
      const byId = new Map<string, ConversationRecord>();
      for (const c of [...dst.list, ...src.list]) {
        const existing = byId.get(c.id);
        if (!existing || c.updatedAt >= existing.updatedAt) byId.set(c.id, c);
      }
      merged = { activeId: src.activeId ?? dst.activeId, list: [...byId.values()] };
    }
    docs[to] = normalizeIndex(merged);
    delete docs[from];
    await store.set(KEY_DOCS, docs);
  });
}

export async function deleteConversationsKey(key: string): Promise<void> {
  takePending(key);
  await enqueueWrite(`delete ${key}`, async (store) => {
    const docs = await readDocs(store);
    if (!(key in docs)) return;
    delete docs[key];
    await store.set(KEY_DOCS, docs);
  });
}

export async function loadKnownModels(engine: EngineKind): Promise<ModelOption[]> {
  try {
    await writeChain;
    const store = await getStore();
    const models = await store.get<ModelsMap>(KEY_MODELS);
    const list = models?.[engine];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    log.warn(`conversationStore: loadKnownModels ${engine} failed`, e);
    return [];
  }
}

export async function saveKnownModels(engine: EngineKind, models: ModelOption[]): Promise<void> {
  await enqueueWrite(`saveKnownModels ${engine}`, async (store) => {
    const all = (await store.get<ModelsMap>(KEY_MODELS)) ?? {};
    await store.set(KEY_MODELS, { ...all, [engine]: models });
  });
}

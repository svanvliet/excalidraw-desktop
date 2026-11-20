/**
 * Live-collaboration sync engine (docs/collab-protocol.md §4).
 *
 * Framework-agnostic: drives an Excalidraw imperative API from encrypted relay
 * messages and broadcasts local edits. Wire it up with:
 *   <Excalidraw onChange={session.onSceneChange} onPointerUpdate={session.onPointerUpdate} />
 */
import {
  CaptureUpdateAction,
  getCommonBounds,
  getVisibleSceneBounds,
  isInvisiblySmallElement,
  reconcileElements,
  restoreElements,
  zoomToFitBounds,
} from "@excalidraw/excalidraw";
import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId,
} from "@excalidraw/excalidraw/types";

import { sceneFileIds } from "../extensions/registry";
import { log } from "../lib/logger";
import { decrypt, encrypt, importKey } from "./crypto";
import type { Payload, RelayErrorCode, Role, RolesMap } from "./protocol";
import type { RelayTransport, TransportEvent, TransportStatus } from "./transport";

export type CollabStatus = "idle" | TransportStatus;

export type UserState = "active" | "idle" | "away";

/** A viewer's own "Ask to edit" state. */
export type EditRequestState = "none" | "pending" | "denied";

export interface CollabPeer {
  clientId: string;
  /** Null until the peer's HELLO arrives. */
  username: string | null;
  isHost: boolean;
  role: Role;
  /** Host only: this viewer asked to edit and hasn't been answered. */
  requestedEdit: boolean;
  userState: UserState;
}

/** The subset of the Excalidraw imperative API the engine needs. */
export type CollabApi = Pick<
  ExcalidrawImperativeAPI,
  "updateScene" | "getSceneElementsIncludingDeleted" | "getAppState" | "getFiles" | "addFiles"
>;

export interface CollabTiming {
  /** SCENE_UPDATE throttle. */
  sceneThrottleMs: number;
  /** MOUSE_LOCATION throttle (~30 Hz). */
  pointerThrottleMs: number;
  /** Full SCENE_INIT re-broadcast interval. */
  antiEntropyMs: number;
  /** Inactivity before IDLE_STATUS "idle". */
  idleAfterMs: number;
  /** Re-request a missing file after this long without an answer. */
  fileRequestRetryMs: number;
}

export const DEFAULT_TIMING: CollabTiming = {
  sceneThrottleMs: 50,
  pointerThrottleMs: 33,
  antiEntropyMs: 20_000,
  idleAfterMs: 60_000,
  fileRequestRetryMs: 5_000,
};

export interface CollabSessionOptions {
  transport: RelayTransport;
  roomId: string;
  /** base64url AES-GCM key from the share link. */
  key: string;
  username: string;
  isHost: boolean;
  api: CollabApi;
  onStatus?: (status: CollabStatus, error?: { code: RelayErrorCode; message: string }) => void;
  onPeersChange?: (peers: CollabPeer[]) => void;
  /** Fires after a remote edit (elements or files) was applied. Never for local edits. */
  onRemoteChange?: () => void;
  /** Our relay-assigned role changed (also fires once on the first welcome). */
  onRoleChange?: (role: Role) => void;
  onEditRequestStateChange?: (state: EditRequestState) => void;
  timing?: Partial<CollabTiming>;
}

export interface PointerUpdatePayload {
  pointer: { x: number; y: number; tool: "pointer" | "laser" };
  button: "down" | "up";
}

type Synced = { version: number; nonce: number };

/** Keeps FILES frames comfortably under the 8 MiB relay limit after encryption + base64. */
const FILES_BATCH_BYTES = 4 * 1024 * 1024;

export class CollabSession {
  private readonly opts: CollabSessionOptions;
  private readonly timing: CollabTiming;
  private readonly cryptoKey: Promise<CryptoKey>;
  private username: string;

  private status: CollabStatus = "idle";
  private clientId: string | null = null;
  private joinedOnce = false;
  private started = false;
  private initialViewApplied = false;
  private stopped = false;
  private unsubscribe: (() => void) | null = null;

  private sendChain: Promise<void> = Promise.resolve();
  private recvChain: Promise<void> = Promise.resolve();

  /** Remote clientIds currently in the room (per relay). */
  private peerIds = new Set<string>();
  private peerInfo = new Map<string, { username: string | null; isHost: boolean }>();
  /** Relay-assigned roles (self included). Null with a pre-roles relay. */
  private roles: RolesMap | null = null;
  private lastRole: Role | null = null;
  /** Host: viewers with an unanswered EDIT_REQUEST. */
  private editRequests = new Set<string>();
  private editRequestState: EditRequestState = "none";
  private collaborators = new Map<SocketId, Collaborator>();

  /** Last version/nonce known to be shared with the room, per element id. */
  private synced = new Map<string, Synced>();
  private sentFiles = new Set<string>();
  private requestedFiles = new Map<string, number>();

  private sceneTimer: ReturnType<typeof setTimeout> | null = null;
  private pointerTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPointer: PointerUpdatePayload | null = null;
  private antiEntropyTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private userState: UserState = "active";
  private visibilityHandler: (() => void) | null = null;

  constructor(opts: CollabSessionOptions) {
    this.opts = opts;
    this.username = opts.username;
    this.timing = { ...DEFAULT_TIMING, ...opts.timing };
    this.cryptoKey = importKey(opts.key);
    // Surface a bad key once instead of on every send.
    this.cryptoKey.catch((e) => log.error("collab: invalid room key", e));
  }

  // ------------------------------------------------------------------ public

  get currentStatus(): CollabStatus {
    return this.status;
  }

  get peers(): CollabPeer[] {
    return [...this.peerIds].map((clientId) => {
      const info = this.peerInfo.get(clientId);
      const collab = this.collaborators.get(clientId as SocketId);
      return {
        clientId,
        username: info?.username ?? null,
        isHost: this.roleOf(clientId) === "host",
        role: this.roleOf(clientId),
        requestedEdit: this.editRequests.has(clientId),
        userState: (collab?.userState as UserState | undefined) ?? "active",
      };
    });
  }

  /** Our role. Before the first welcome: `host` for the host, else `viewer`. */
  get role(): Role {
    if (this.roles && this.clientId) return this.roles[this.clientId] ?? "viewer";
    if (this.roles === null && this.joinedOnce) return this.opts.isHost ? "host" : "editor";
    return this.opts.isHost ? "host" : "viewer";
  }

  get canEdit(): boolean {
    return this.role !== "viewer";
  }

  get currentEditRequestState(): EditRequestState {
    return this.editRequestState;
  }

  /** Viewer: ask the host for edit access. Granting arrives as a role change. */
  requestEdit(): void {
    if (this.role !== "viewer" || this.status !== "connected") return;
    this.send({ type: "EDIT_REQUEST" });
    this.setEditRequestState("pending");
  }

  /** Host: decline a viewer's request. (Grant with `collab_set_role` instead.) */
  denyEdit(clientId: string): void {
    if (this.role !== "host" || !this.editRequests.delete(clientId)) return;
    this.send({ type: "EDIT_DENIED", clientId });
    this.emitPeers();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.markAllSynced(this.opts.api.getSceneElementsIncludingDeleted());
    this.unsubscribe = this.opts.transport.subscribe((e) => this.onTransportEvent(e));
    this.antiEntropyTimer = setInterval(() => this.broadcastFullScene(), this.timing.antiEntropyMs);
    this.resetIdleTimer();
    if (typeof document !== "undefined") {
      this.visibilityHandler = () =>
        this.setUserState(document.visibilityState === "hidden" ? "away" : "active");
      document.addEventListener("visibilitychange", this.visibilityHandler);
    }
    log.info(`collab: starting session room=${this.opts.roomId} host=${this.opts.isHost}`);
    this.opts.transport.connect(this.opts.roomId);
  }

  /** Flushes pending edits, then closes the connection. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.sceneTimer) this.flushScene();
    this.clearTimers();
    if (this.visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
    }
    await this.sendChain;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.opts.transport.close();
    this.peerIds.clear();
    this.collaborators.clear();
    this.pushCollaborators();
    this.setStatus("closed");
  }

  /** Pass to `<Excalidraw onChange>`. Safe to call for remote-applied changes (no echo). */
  onSceneChange = (
    elements?: readonly OrderedExcalidrawElement[],
    _appState?: AppState,
    _files?: BinaryFiles,
  ): void => {
    if (this.stopped || !this.started || !this.canEdit) return;
    const current = elements ?? this.opts.api.getSceneElementsIncludingDeleted();
    if (!current.some((el) => this.isUnsynced(el))) return;
    this.noteActivity();
    if (this.sceneTimer) return;
    this.sceneTimer = setTimeout(() => {
      this.sceneTimer = null;
      this.flushScene();
    }, this.timing.sceneThrottleMs);
  };

  /** Pass to `<Excalidraw onPointerUpdate>`. */
  onPointerUpdate = (payload: PointerUpdatePayload): void => {
    if (this.stopped || !this.started) return;
    this.noteActivity();
    this.pendingPointer = { pointer: payload.pointer, button: payload.button };
    if (this.pointerTimer) return;
    this.sendPointer();
    this.pointerTimer = setTimeout(() => {
      this.pointerTimer = null;
      if (this.pendingPointer) this.sendPointer();
    }, this.timing.pointerThrottleMs);
  };

  setUsername(username: string): void {
    if (username === this.username) return;
    this.username = username;
    if (this.status === "connected") this.sendHello();
  }

  // --------------------------------------------------------------- transport

  private onTransportEvent(e: TransportEvent): void {
    if (this.stopped) return;
    switch (e.type) {
      case "status":
        if (e.status !== "connected") this.setStatus(e.status, e.error);
        if (e.status !== "connecting" && e.status !== "connected") {
          this.peerIds.clear();
          this.collaborators.clear();
          this.pushCollaborators();
          this.emitPeers();
        }
        return;
      case "welcome":
        this.roles = e.roles ?? null;
        this.onWelcome(e.clientId, e.peers, e.firstInRoom);
        return;
      case "peers":
        if (e.roles) this.roles = e.roles;
        this.onPeers(e.peers);
        return;
      case "message":
        this.onMessage(e.from, e.iv, e.data);
        return;
      case "error":
        log.warn(`collab: relay error ${e.code}: ${e.message}`);
        return;
    }
  }

  private onWelcome(clientId: string, peers: string[], firstInRoom: boolean): void {
    const rejoin = this.joinedOnce;
    this.clientId = clientId;
    this.joinedOnce = true;
    this.setStatus("connected");
    this.onPeers(peers, /* announce */ false);
    this.sendHello();
    if (this.userState !== "active") this.sendIdleStatus();
    if (!firstInRoom) this.send({ type: "SYNC_REQUEST" });
    // Push anything edited while we were offline.
    if (rejoin && peers.length > 0 && this.canEdit) this.broadcastFullScene();
    // The host forgot our request when our old connection left.
    if (rejoin && this.editRequestState === "pending" && this.role === "viewer") {
      this.send({ type: "EDIT_REQUEST" });
    }
    log.info(`collab: joined as ${clientId} (${peers.length} peer(s), rejoin=${rejoin})`);
  }

  private onPeers(all: string[], announce = true): void {
    const next = new Set(all.filter((id) => id !== this.clientId));
    let added = false;
    for (const id of next) {
      if (!this.peerIds.has(id)) {
        added = true;
        this.collaborators.set(id as SocketId, this.makeCollaborator(id));
      }
    }
    for (const id of this.peerIds) {
      if (!next.has(id)) {
        this.collaborators.delete(id as SocketId);
        this.peerInfo.delete(id);
        this.editRequests.delete(id);
      }
    }
    this.peerIds = next;
    for (const id of this.editRequests)
      if (this.roleOf(id) !== "viewer") this.editRequests.delete(id);
    this.checkRoleChange();
    // Let newcomers learn our name / host flag.
    if (announce && added) this.sendHello();
    this.pushCollaborators();
    this.emitPeers();
  }

  private onMessage(from: string, iv: string, data: string): void {
    this.recvChain = this.recvChain
      .then(async () => {
        const payload = await decrypt<Payload>(await this.cryptoKey, { iv, data });
        if (!this.stopped) this.handlePayload(from, payload);
      })
      .catch((e) => log.warn(`collab: dropping undecryptable/invalid message from ${from}`, e));
  }

  // ---------------------------------------------------------------- payloads

  private handlePayload(from: string, p: Payload): void {
    switch (p.type) {
      case "HELLO":
        this.peerInfo.set(from, { username: p.username, isHost: p.isHost });
        this.updateCollaborator(from, { username: p.username });
        this.emitPeers();
        return;
      case "SYNC_REQUEST":
        if (this.canEdit && this.shouldAnswerSync(from)) {
          this.sendFiles(this.referencedFileIds(this.opts.api.getSceneElementsIncludingDeleted()));
          this.broadcastFullScene(true);
        }
        return;
      case "SCENE_INIT":
      case "SCENE_UPDATE":
        if (!this.mayEdit(from, p.type)) return;
        if (Array.isArray(p.elements)) this.applyRemoteElements(p.elements);
        if (p.type === "SCENE_INIT") this.applyInitialView(p.viewport);
        return;
      case "MOUSE_LOCATION":
        this.updateCollaborator(from, {
          pointer: p.pointer,
          button: p.button,
          selectedElementIds: p.selectedElementIds,
          username: p.username,
        });
        return;
      case "IDLE_STATUS":
        this.updateCollaborator(from, {
          userState: p.userState as Collaborator["userState"],
          username: p.username,
        });
        this.emitPeers();
        return;
      case "FILES":
        if (!this.mayEdit(from, p.type)) return;
        this.applyRemoteFiles(p.files);
        return;
      case "FILES_REQUEST":
        if (this.canEdit) this.sendFiles(p.ids);
        return;
      case "EDIT_REQUEST":
        if (this.role !== "host" || this.roleOf(from) !== "viewer") return;
        if (!this.editRequests.has(from)) {
          this.editRequests.add(from);
          this.emitPeers();
        }
        return;
      case "EDIT_DENIED":
        if (this.roleOf(from) === "host" && p.clientId === this.clientId) {
          this.setEditRequestState("denied");
        }
        return;
      default:
        log.warn(`collab: ignoring unknown payload ${(p as { type?: unknown }).type}`);
    }
  }

  private shouldAnswerSync(requester: string): boolean {
    if (this.role === "host") return true;
    const hostPresent = [...this.peerIds].some((id) => this.roleOf(id) === "host");
    if (hostPresent || !this.clientId) return false;
    // No host: exactly one editor (lowest clientId, excluding the requester) answers.
    const candidates = [this.clientId, ...this.peerIds]
      .filter((id) => id !== requester && this.roleOf(id) !== "viewer")
      .sort();
    return candidates[0] === this.clientId;
  }

  /** Role of a room member. Without relay roles: HELLO host flag, else editor. */
  private roleOf(id: string): Role {
    if (id === this.clientId) return this.role;
    if (this.roles) return this.roles[id] ?? "viewer";
    return this.peerInfo.get(id)?.isHost ? "host" : "editor";
  }

  private mayEdit(from: string, what: string): boolean {
    if (this.roleOf(from) !== "viewer") return true;
    log.warn(`collab: dropping ${what} from viewer ${from}`);
    return false;
  }

  private checkRoleChange(): void {
    if (!this.joinedOnce) return;
    const role = this.role;
    if (role === this.lastRole) return;
    const was = this.lastRole;
    this.lastRole = role;
    if (role === "viewer") {
      // Demoted: drop unsent local edits rather than broadcast them.
      if (this.sceneTimer) clearTimeout(this.sceneTimer);
      this.sceneTimer = null;
    } else {
      this.markAllSynced(this.opts.api.getSceneElementsIncludingDeleted());
      this.setEditRequestState("none");
    }
    log.info(`collab: role ${was ?? "(none)"} -> ${role}`);
    this.opts.onRoleChange?.(role);
  }

  private setEditRequestState(state: EditRequestState): void {
    if (state === this.editRequestState) return;
    this.editRequestState = state;
    this.opts.onEditRequestStateChange?.(state);
  }

  private applyRemoteElements(incoming: readonly OrderedExcalidrawElement[]): void {
    const { api } = this.opts;
    const local = api.getSceneElementsIncludingDeleted();
    const remote = restoreElements(incoming, null) as RemoteExcalidrawElement[];
    const reconciled = reconcileElements(local, remote, api.getAppState());

    const byId = new Map(reconciled.map((el) => [el.id, el]));
    for (const r of remote) {
      const winner = byId.get(r.id);
      if (winner && winner.version === r.version && winner.versionNonce === r.versionNonce) {
        this.synced.set(r.id, { version: r.version, nonce: r.versionNonce });
      }
    }

    if (sceneDiffers(local, reconciled)) {
      api.updateScene({ elements: reconciled, captureUpdate: CaptureUpdateAction.NEVER });
      this.opts.onRemoteChange?.();
    }
    this.requestMissingFiles(reconciled);
  }

  private applyRemoteFiles(files: BinaryFileData[]): void {
    if (!Array.isArray(files)) return;
    const have = this.opts.api.getFiles();
    const fresh = files.filter((f) => f && typeof f.id === "string" && !have[f.id]);
    for (const f of files) {
      this.requestedFiles.delete(f.id);
      this.sentFiles.add(f.id);
    }
    if (fresh.length === 0) return;
    this.opts.api.addFiles(fresh);
    this.opts.onRemoteChange?.();
  }

  // ----------------------------------------------------------------- sending

  private send(payload: Payload, volatile = false): void {
    const transport = this.opts.transport;
    this.sendChain = this.sendChain
      .then(async () => {
        const blob = await encrypt(await this.cryptoKey, payload);
        transport.broadcast({ volatile, ...blob });
      })
      .catch((e) => log.warn(`collab: failed to send ${payload.type}`, e));
  }

  private sendHello(): void {
    this.send({ type: "HELLO", username: this.username, isHost: this.opts.isHost });
  }

  private sendIdleStatus(): void {
    this.send(
      { type: "IDLE_STATUS", userState: this.userState, username: this.username },
      /* volatile */ true,
    );
  }

  private sendPointer(): void {
    const p = this.pendingPointer;
    this.pendingPointer = null;
    if (!p || this.status !== "connected" || this.peerIds.size === 0) return;
    const selected = this.opts.api.getAppState().selectedElementIds ?? {};
    const selectedElementIds: Record<string, true> = {};
    for (const [id, on] of Object.entries(selected)) if (on) selectedElementIds[id] = true;
    this.send(
      {
        type: "MOUSE_LOCATION",
        pointer: { x: p.pointer.x, y: p.pointer.y, tool: p.pointer.tool },
        button: p.button,
        selectedElementIds,
        username: this.username,
      },
      /* volatile */ true,
    );
  }

  private flushScene(): void {
    if (this.status !== "connected" || !this.canEdit) return;
    const elements = this.opts.api.getSceneElementsIncludingDeleted();
    const changed = elements.filter(
      (el) => this.isUnsynced(el) && (el.isDeleted || !isInvisiblySmallElement(el)),
    );
    if (changed.length === 0) return;
    this.markAllSynced(changed);
    // Files first so receivers don't FILES_REQUEST what's already in flight.
    this.sendFiles(
      this.referencedFileIds(changed).filter((id) => !this.sentFiles.has(id)),
      /* quietIfMissing */ true,
    );
    this.send({ type: "SCENE_UPDATE", elements: changed });
  }

  private broadcastFullScene(withViewport = false): void {
    if (this.status !== "connected" || this.peerIds.size === 0 || !this.canEdit) return;
    const elements = this.opts.api
      .getSceneElementsIncludingDeleted()
      .filter((el) => el.isDeleted || !isInvisiblySmallElement(el));
    this.markAllSynced(elements);
    const viewport = withViewport ? this.visibleBounds() : undefined;
    this.send({ type: "SCENE_INIT", elements, ...(viewport ? { viewport } : {}) });
  }

  private visibleBounds(): [number, number, number, number] | undefined {
    const s = this.opts.api.getAppState();
    if (!s.width || !s.height || !s.zoom) return undefined;
    const b = getVisibleSceneBounds(s);
    return b.every(Number.isFinite) ? [b[0], b[1], b[2], b[3]] : undefined;
  }

  /**
   * On a guest's first full scene, open on the sharer's view (or fit the
   * content if the sender didn't include one). Never moves the host, and
   * never re-runs on anti-entropy or reconnects.
   */
  private applyInitialView(viewport?: readonly number[]): void {
    if (this.initialViewApplied || this.opts.isHost) return;
    this.initialViewApplied = true;
    const appState = this.opts.api.getAppState();
    if (!appState.width || !appState.height) return;
    let bounds: [number, number, number, number] | null = null;
    let fitToViewport = false;
    if (
      Array.isArray(viewport) &&
      viewport.length === 4 &&
      viewport.every(Number.isFinite) &&
      viewport[2] > viewport[0] &&
      viewport[3] > viewport[1]
    ) {
      bounds = [viewport[0], viewport[1], viewport[2], viewport[3]];
      fitToViewport = true;
    } else {
      const visible = this.opts.api
        .getSceneElementsIncludingDeleted()
        .filter((el) => !el.isDeleted);
      if (visible.length > 0) {
        const [x1, y1, x2, y2] = getCommonBounds(visible);
        bounds = [x1, y1, x2, y2];
      }
    }
    if (!bounds) return;
    const { scrollX, scrollY, zoom } = zoomToFitBounds({
      bounds,
      appState,
      fitToViewport,
      viewportZoomFactor: fitToViewport ? 1 : 0.9,
    }).appState;
    this.opts.api.updateScene({
      appState: { scrollX, scrollY, zoom },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }

  private sendFiles(ids: readonly string[], quietIfMissing = false): void {
    if (ids.length === 0) return;
    const have = this.opts.api.getFiles();
    let batch: BinaryFileData[] = [];
    let size = 0;
    const flush = () => {
      if (batch.length) this.send({ type: "FILES", files: batch });
      batch = [];
      size = 0;
    };
    for (const id of new Set(ids)) {
      const file = have[id];
      if (!file) {
        if (!quietIfMissing) log.debug(`collab: asked for file ${id} we don't have`);
        continue;
      }
      const bytes = file.dataURL.length;
      if (bytes > FILES_BATCH_BYTES * 1.5) {
        log.warn(`collab: file ${id} is too large to share (${bytes} bytes)`);
        continue;
      }
      if (size + bytes > FILES_BATCH_BYTES) flush();
      batch.push(file);
      size += bytes;
      this.sentFiles.add(id);
    }
    flush();
  }

  private requestMissingFiles(elements: readonly OrderedExcalidrawElement[]): void {
    const have = this.opts.api.getFiles();
    const now = Date.now();
    const missing = this.referencedFileIds(elements.filter((el) => !el.isDeleted)).filter((id) => {
      if (have[id]) return false;
      const at = this.requestedFiles.get(id);
      return at === undefined || now - at >= this.timing.fileRequestRetryMs;
    });
    if (missing.length === 0) return;
    for (const id of missing) this.requestedFiles.set(id, now);
    this.send({ type: "FILES_REQUEST", ids: missing });
  }

  // ---------------------------------------------------------------- helpers

  private referencedFileIds(elements: readonly OrderedExcalidrawElement[]): string[] {
    // Includes extension source files (e.g. a masked image's original), which no element's
    // `fileId` points at.
    return sceneFileIds(elements);
  }

  private isUnsynced(el: OrderedExcalidrawElement): boolean {
    const s = this.synced.get(el.id);
    return !s || s.version !== el.version || s.nonce !== el.versionNonce;
  }

  private markAllSynced(elements: readonly OrderedExcalidrawElement[]): void {
    for (const el of elements) {
      this.synced.set(el.id, { version: el.version, nonce: el.versionNonce });
    }
  }

  private makeCollaborator(id: string): Collaborator {
    return {
      socketId: id as SocketId,
      id,
      username: this.peerInfo.get(id)?.username ?? null,
      isCurrentUser: false,
    };
  }

  private updateCollaborator(id: string, patch: Partial<Collaborator>): void {
    if (!this.peerIds.has(id)) return;
    const prev = this.collaborators.get(id as SocketId) ?? this.makeCollaborator(id);
    this.collaborators.set(id as SocketId, { ...prev, ...patch, isCurrentUser: false });
    this.pushCollaborators();
  }

  private pushCollaborators(): void {
    try {
      this.opts.api.updateScene({ collaborators: new Map(this.collaborators) });
    } catch (e) {
      log.warn("collab: failed to push collaborators", e);
    }
  }

  private emitPeers(): void {
    this.opts.onPeersChange?.(this.peers);
  }

  private setStatus(status: CollabStatus, error?: { code: RelayErrorCode; message: string }): void {
    if (status === this.status && !error) return;
    this.status = status;
    this.opts.onStatus?.(status, error);
  }

  private noteActivity(): void {
    this.setUserState("active");
    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.userState === "active") this.setUserState("idle");
    }, this.timing.idleAfterMs);
  }

  private setUserState(state: UserState): void {
    if (state === this.userState) return;
    this.userState = state;
    if (this.status === "connected") this.sendIdleStatus();
  }

  private clearTimers(): void {
    for (const t of [this.sceneTimer, this.pointerTimer, this.idleTimer]) if (t) clearTimeout(t);
    if (this.antiEntropyTimer) clearInterval(this.antiEntropyTimer);
    this.sceneTimer = this.pointerTimer = this.idleTimer = this.antiEntropyTimer = null;
  }
}

function sceneDiffers(
  a: readonly OrderedExcalidrawElement[],
  b: readonly OrderedExcalidrawElement[],
): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id || x.version !== y.version || x.versionNonce !== y.versionNonce) return true;
  }
  return false;
}

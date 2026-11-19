//! Loopback WebSocket relay + guest asset server (docs/collab-protocol.md §1, §3).
//!
//! Independent of Tauri: the host app plugs in an [`AssetSource`] and a
//! peer-count callback, tests use real sockets against [`RelayServer`].

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;

use super::protocol::{
    is_valid_room_id, new_client_id, parse_client_frame, ClientFrame, ErrorCode, ParseError,
    ServerFrame, CLOSE_POLICY, CLOSE_SESSION_ENDED, CLOSE_TRY_AGAIN_LATER, CLOSE_UNSUPPORTED_DATA,
    HARD_FRAME_BYTES, MAX_FRAME_BYTES, MAX_PEERS_PER_ROOM, PROTOCOL_VERSION,
};

/// CSP for the guest web app. `wasm-unsafe-eval` is needed by Excalidraw's
/// font subsetting (harfbuzz/woff2 wasm) and pica image resizing; pica also
/// spawns workers from `blob:`/`data:` URLs. Fonts must be served locally
/// (frontend sets `EXCALIDRAW_ASSET_PATH`), so no CDN is allowed.
pub const GUEST_CSP: &str = "default-src 'self'; img-src 'self' data: blob:; \
style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; \
worker-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' data: blob:; \
object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

/// Volatile frames are dropped once this many frames are queued for a peer.
const VOLATILE_QUEUE_LIMIT: usize = 16;
/// A peer whose reliable backlog exceeds this is disconnected (1013).
const RELIABLE_QUEUE_BYTES_LIMIT: usize = 64 * 1024 * 1024;

pub struct Asset {
    pub bytes: Vec<u8>,
    pub mime: String,
}

/// Static web assets for browser guests. `path` has no leading slash.
pub trait AssetSource: Send + Sync + 'static {
    fn get(&self, path: &str) -> Option<Asset>;
}

/// Called with `(room, peer_count)` whenever a room's membership changes.
pub type PeerCountFn = Arc<dyn Fn(&str, usize) + Send + Sync>;

enum Outgoing {
    Text(Utf8Bytes),
    Close(u16, &'static str),
}

#[derive(Clone)]
struct PeerHandle {
    id: String,
    tx: mpsc::UnboundedSender<Outgoing>,
    queued_msgs: Arc<AtomicUsize>,
    queued_bytes: Arc<AtomicUsize>,
}

impl PeerHandle {
    fn send(&self, text: Utf8Bytes, volatile: bool) {
        if volatile && self.queued_msgs.load(Ordering::Relaxed) >= VOLATILE_QUEUE_LIMIT {
            return;
        }
        let len = text.len();
        if !volatile && self.queued_bytes.load(Ordering::Relaxed) + len > RELIABLE_QUEUE_BYTES_LIMIT
        {
            log::warn!("collab relay: peer {} too slow, disconnecting", self.id);
            self.close(CLOSE_TRY_AGAIN_LATER, "backlog too large");
            return;
        }
        self.queued_msgs.fetch_add(1, Ordering::Relaxed);
        self.queued_bytes.fetch_add(len, Ordering::Relaxed);
        if self.tx.send(Outgoing::Text(text)).is_err() {
            self.queued_msgs.fetch_sub(1, Ordering::Relaxed);
            self.queued_bytes.fetch_sub(len, Ordering::Relaxed);
        }
    }

    fn close(&self, code: u16, reason: &'static str) {
        let _ = self.tx.send(Outgoing::Close(code, reason));
    }
}

struct RelayState {
    rooms: Mutex<HashMap<String, Vec<PeerHandle>>>,
    on_peers: Option<PeerCountFn>,
    assets: Option<Arc<dyn AssetSource>>,
    shutdown: watch::Receiver<bool>,
}

impl RelayState {
    fn notify(&self, room: &str, count: usize) {
        if let Some(cb) = &self.on_peers {
            cb(room, count);
        }
    }

    fn peers_frame(peers: &[PeerHandle]) -> Utf8Bytes {
        ServerFrame::Peers {
            peers: peers.iter().map(|p| p.id.as_str()).collect(),
        }
        .to_json()
        .into()
    }

    /// Returns the assigned client id, or the fatal error code.
    fn join(&self, room: &str, mut peer: PeerHandle) -> Result<String, ErrorCode> {
        let count = {
            let mut rooms = self.rooms.lock().unwrap();
            let peers = rooms.get_mut(room).ok_or(ErrorCode::UnknownRoom)?;
            if peers.len() >= MAX_PEERS_PER_ROOM {
                return Err(ErrorCode::RoomFull);
            }
            let mut id = new_client_id();
            while peers.iter().any(|p| p.id == id) {
                id = new_client_id();
            }
            peer.id = id;
            let welcome = ServerFrame::Welcome {
                client_id: &peer.id,
                peers: peers.iter().map(|p| p.id.as_str()).collect(),
                first_in_room: peers.is_empty(),
            }
            .to_json();
            peer.send(welcome.into(), false);
            peers.push(peer.clone());
            let frame = Self::peers_frame(peers);
            for p in peers.iter() {
                p.send(frame.clone(), false);
            }
            peers.len()
        };
        self.notify(room, count);
        Ok(peer.id)
    }

    fn leave(&self, room: &str, id: &str) {
        let count = {
            let mut rooms = self.rooms.lock().unwrap();
            let Some(peers) = rooms.get_mut(room) else {
                return;
            };
            let before = peers.len();
            peers.retain(|p| p.id != id);
            if peers.len() == before {
                return;
            }
            let frame = Self::peers_frame(peers);
            for p in peers.iter() {
                p.send(frame.clone(), false);
            }
            peers.len()
        };
        self.notify(room, count);
    }

    fn broadcast(&self, room: &str, from: &str, volatile: bool, iv: &str, data: &str) {
        let rooms = self.rooms.lock().unwrap();
        let Some(peers) = rooms.get(room) else {
            return;
        };
        let frame: Utf8Bytes = ServerFrame::Message {
            from,
            volatile,
            iv,
            data,
        }
        .to_json()
        .into();
        for p in peers.iter().filter(|p| p.id != from) {
            p.send(frame.clone(), volatile);
        }
    }
}

/// A running relay bound to `127.0.0.1:<port>`.
pub struct RelayServer {
    state: Arc<RelayState>,
    port: u16,
    shutdown_tx: watch::Sender<bool>,
    serve_shutdown: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl RelayServer {
    /// Bind to `127.0.0.1:port` (0 = pick a free port) and start serving.
    pub async fn bind(
        port: u16,
        assets: Option<Arc<dyn AssetSource>>,
        on_peers: Option<PeerCountFn>,
    ) -> std::io::Result<Self> {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await?;
        let port = listener.local_addr()?.port();
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let state = Arc::new(RelayState {
            rooms: Mutex::new(HashMap::new()),
            on_peers,
            assets,
            shutdown: shutdown_rx,
        });
        let app = Router::new()
            .route("/ws", get(ws_handler))
            .route("/healthz", get(healthz))
            .fallback(asset_handler)
            .with_state(state.clone());
        let (serve_tx, serve_rx) = oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            let server = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = serve_rx.await;
            });
            if let Err(e) = server.await {
                log::error!("collab relay: server error: {e}");
            }
        });
        log::info!("collab relay: listening on 127.0.0.1:{port}");
        Ok(Self {
            state,
            port,
            shutdown_tx,
            serve_shutdown: Some(serve_tx),
            task: Some(task),
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Allow peers to join `room`. Idempotent.
    pub fn register_room(&self, room: &str) {
        self.state
            .rooms
            .lock()
            .unwrap()
            .entry(room.to_owned())
            .or_default();
        log::info!("collab relay: registered room {room}");
    }

    /// Close every socket in `room` with code 4000 and unregister it.
    pub fn close_room(&self, room: &str) {
        let peers = self.state.rooms.lock().unwrap().remove(room);
        if let Some(peers) = peers {
            log::info!("collab relay: closing room {room} ({} peers)", peers.len());
            for p in &peers {
                p.close(CLOSE_SESSION_ENDED, "session ended");
            }
            self.state.notify(room, 0);
        }
    }

    pub fn peer_count(&self, room: &str) -> usize {
        self.state
            .rooms
            .lock()
            .unwrap()
            .get(room)
            .map_or(0, Vec::len)
    }

    /// Close all rooms (4000), disconnect stragglers and stop listening.
    pub async fn shutdown(mut self) {
        let rooms: Vec<String> = self.state.rooms.lock().unwrap().keys().cloned().collect();
        for room in rooms {
            self.close_room(&room);
        }
        let _ = self.shutdown_tx.send(true);
        if let Some(tx) = self.serve_shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(mut task) = self.task.take() {
            if tokio::time::timeout(Duration::from_secs(3), &mut task)
                .await
                .is_err()
            {
                task.abort();
            }
        }
        log::info!("collab relay: stopped (port {})", self.port);
    }
}

impl Drop for RelayServer {
    fn drop(&mut self) {
        let _ = self.shutdown_tx.send(true);
        if let Some(tx) = self.serve_shutdown.take() {
            let _ = tx.send(());
        }
    }
}

async fn healthz() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/json")],
        format!(r#"{{"ok":true,"protocol":{PROTOCOL_VERSION}}}"#),
    )
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<RelayState>>) -> Response {
    ws.max_message_size(HARD_FRAME_BYTES)
        .max_frame_size(HARD_FRAME_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<RelayState>) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Outgoing>();
    let queued_msgs = Arc::new(AtomicUsize::new(0));
    let queued_bytes = Arc::new(AtomicUsize::new(0));
    let me = PeerHandle {
        id: String::new(),
        tx,
        queued_msgs: queued_msgs.clone(),
        queued_bytes: queued_bytes.clone(),
    };

    let mut writer = tokio::spawn(async move {
        while let Some(out) = rx.recv().await {
            match out {
                Outgoing::Text(text) => {
                    let len = text.len();
                    let res = sink.send(Message::Text(text)).await;
                    queued_msgs.fetch_sub(1, Ordering::Relaxed);
                    queued_bytes.fetch_sub(len, Ordering::Relaxed);
                    if res.is_err() {
                        break;
                    }
                }
                Outgoing::Close(code, reason) => {
                    let _ = sink
                        .send(Message::Close(Some(CloseFrame {
                            code,
                            reason: reason.into(),
                        })))
                        .await;
                    let _ = sink.flush().await;
                    break;
                }
            }
        }
    });

    let send_error = |code: ErrorCode, message: &str| {
        me.send(ServerFrame::Error { code, message }.to_json().into(), false);
        if code.is_fatal() {
            me.close(CLOSE_POLICY, "protocol error");
        }
    };

    let mut shutdown = state.shutdown.clone();
    let mut joined: Option<(String, String)> = None;
    let mut closing = false;
    let mut writer_done = false;
    loop {
        tokio::select! {
            res = &mut writer, if !writer_done => {
                let _ = res;
                writer_done = true;
                break;
            }
            _ = shutdown.changed(), if !closing => {
                closing = true;
                me.close(1001, "relay shutting down");
            }
            msg = stream.next() => {
                let Some(Ok(msg)) = msg else { break };
                if closing {
                    continue;
                }
                let text = match msg {
                    Message::Text(t) => t,
                    Message::Binary(_) => {
                        send_error(ErrorCode::BadFrame, "binary frames are not supported");
                        continue;
                    }
                    Message::Close(_) => break,
                    _ => continue,
                };
                if text.len() > MAX_FRAME_BYTES {
                    send_error(ErrorCode::TooLarge, "frame exceeds 8 MiB");
                    continue;
                }
                match parse_client_frame(text.as_str()) {
                    Err(ParseError::Malformed) => {
                        closing = true;
                        me.close(CLOSE_UNSUPPORTED_DATA, "malformed json");
                    }
                    Err(ParseError::BadFrame(m)) => send_error(ErrorCode::BadFrame, &m),
                    Ok(ClientFrame::Join { room, protocol }) => {
                        if joined.is_some() {
                            closing = true;
                            send_error(ErrorCode::Protocol, "already joined");
                        } else if protocol != PROTOCOL_VERSION {
                            closing = true;
                            send_error(ErrorCode::Protocol, "unsupported protocol version");
                        } else if !is_valid_room_id(&room) {
                            closing = true;
                            send_error(ErrorCode::UnknownRoom, "unknown room");
                        } else {
                            match state.join(&room, me.clone()) {
                                Ok(id) => joined = Some((room, id)),
                                Err(code) => {
                                    closing = true;
                                    let message = match code {
                                        ErrorCode::RoomFull => "room is full",
                                        _ => "unknown room",
                                    };
                                    send_error(code, message);
                                }
                            }
                        }
                    }
                    Ok(ClientFrame::Broadcast { volatile, iv, data }) => match &joined {
                        Some((room, id)) => state.broadcast(room, id, volatile, &iv, &data),
                        None => {
                            closing = true;
                            send_error(ErrorCode::Protocol, "join must be the first frame");
                        }
                    },
                }
            }
        }
        if closing {
            if let Some((room, id)) = joined.take() {
                state.leave(&room, &id);
            }
        }
    }

    if let Some((room, id)) = joined.take() {
        state.leave(&room, &id);
    }
    drop(me);
    if !writer_done {
        let _ = tokio::time::timeout(Duration::from_secs(2), &mut writer).await;
        writer.abort();
    }
}

/// Map a request path to an asset key; `None` rejects traversal attempts.
pub fn asset_key(path: &str) -> Option<String> {
    let trimmed = path.trim_start_matches('/');
    if trimmed
        .split('/')
        .any(|seg| seg == ".." || seg == "." || seg.contains('\\'))
    {
        return None;
    }
    if trimmed.is_empty() || trimmed.ends_with('/') {
        return Some(format!("{trimmed}index.html"));
    }
    Some(trimmed.to_owned())
}

async fn asset_handler(method: Method, uri: Uri, State(state): State<Arc<RelayState>>) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let Some(key) = asset_key(uri.path()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(assets) = state.assets.as_ref() else {
        return unavailable();
    };
    let is_spa_route = !key.rsplit('/').next().unwrap_or("").contains('.');
    let (key, asset) = match assets.get(&key) {
        Some(a) => (key, a),
        None if is_spa_route => match assets.get("index.html") {
            Some(a) => ("index.html".to_owned(), a),
            None => return unavailable(),
        },
        None if key == "index.html" => return unavailable(),
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    let mime = if asset.mime.is_empty() {
        mime_guess::from_path(&key)
            .first_or_octet_stream()
            .to_string()
    } else {
        asset.mime
    };
    let cache = if key.ends_with(".html") {
        "no-cache"
    } else {
        "public, max-age=3600"
    };
    let mut resp = asset.bytes.into_response();
    let h = resp.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&mime) {
        h.insert(header::CONTENT_TYPE, v);
    }
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(GUEST_CSP),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    resp
}

fn unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "Excalidraw guest assets are unavailable. In dev builds, run `npm run build` first.",
    )
        .into_response()
}

#[cfg(test)]
#[path = "relay_tests.rs"]
mod tests;

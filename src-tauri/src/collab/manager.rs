//! Collab session state machine behind `collab_start/stop/status`
//! (docs/collab-protocol.md §5). Tauri-free: the command layer injects an
//! emitter and asset source.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use super::protocol::is_valid_room_id;
use super::relay::{AssetSource, PeerCountFn, RelayServer};
use super::tunnel::{self, TunnelMode};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabStartArgs {
    pub room_id: String,
    pub port: u16,
    pub tunnel: TunnelMode,
    #[serde(default)]
    pub manual_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelState {
    Off,
    Starting,
    Ready,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub mode: Option<TunnelMode>,
    pub state: TunnelState,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabStatus {
    pub running: bool,
    pub room_id: Option<String>,
    pub local_port: Option<u16>,
    pub local_base: Option<String>,
    pub public_base: Option<String>,
    pub tunnel: TunnelStatus,
    pub peer_count: usize,
}

impl CollabStatus {
    pub fn off() -> Self {
        Self {
            running: false,
            room_id: None,
            local_port: None,
            local_base: None,
            public_base: None,
            tunnel: TunnelStatus {
                mode: None,
                state: TunnelState::Off,
                error: None,
            },
            peer_count: 0,
        }
    }
}

pub type EmitFn = Arc<dyn Fn(&CollabStatus) + Send + Sync>;

/// Shared status cell; emits on every actual change.
struct StatusHub {
    status: Mutex<CollabStatus>,
    /// Bumped whenever the tunnel is (re)started or stopped so late
    /// callbacks from an old tunnel task are ignored.
    tunnel_gen: Mutex<u64>,
    emit: EmitFn,
}

impl StatusHub {
    fn update(&self, f: impl FnOnce(&mut CollabStatus)) -> CollabStatus {
        let (changed, snapshot) = {
            let mut s = self.status.lock().unwrap();
            let before = s.clone();
            f(&mut s);
            (*s != before, s.clone())
        };
        if changed {
            (self.emit)(&snapshot);
        }
        snapshot
    }

    fn update_tunnel(&self, gen: u64, f: impl FnOnce(&mut CollabStatus)) {
        if *self.tunnel_gen.lock().unwrap() == gen {
            self.update(f);
        }
    }

    fn next_gen(&self) -> u64 {
        let mut g = self.tunnel_gen.lock().unwrap();
        *g += 1;
        *g
    }

    fn get(&self) -> CollabStatus {
        self.status.lock().unwrap().clone()
    }
}

struct TunnelTask {
    stop: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

impl TunnelTask {
    async fn stop(mut self) {
        if let Some(tx) = self.stop.take() {
            let _ = tx.send(());
        }
        let _ = self.task.await;
    }
}

#[derive(Default)]
struct Inner {
    relay: Option<RelayServer>,
    room: Option<String>,
    tunnel_cfg: Option<(TunnelMode, Option<String>)>,
    tunnel: Option<TunnelTask>,
}

pub struct CollabManager {
    hub: Arc<StatusHub>,
    inner: tokio::sync::Mutex<Inner>,
    assets: Option<Arc<dyn AssetSource>>,
    tunnel_id: String,
}

impl CollabManager {
    pub fn new(emit: EmitFn, assets: Option<Arc<dyn AssetSource>>, profile: Option<&str>) -> Self {
        Self {
            hub: Arc::new(StatusHub {
                status: Mutex::new(CollabStatus::off()),
                tunnel_gen: Mutex::new(0),
                emit,
            }),
            inner: tokio::sync::Mutex::new(Inner::default()),
            assets,
            tunnel_id: tunnel::tunnel_id(profile),
        }
    }

    pub fn status(&self) -> CollabStatus {
        self.hub.get()
    }

    pub async fn start(&self, args: CollabStartArgs) -> Result<CollabStatus, String> {
        if !is_valid_room_id(&args.room_id) {
            return Err("invalid roomId: expected 20 lowercase hex chars".to_owned());
        }
        let manual = match args.tunnel {
            TunnelMode::Manual => Some(tunnel::validate_manual_url(
                args.manual_url.as_deref().unwrap_or(""),
            )?),
            _ => None,
        };

        let mut inner = self.inner.lock().await;

        if let Some(relay) = &inner.relay {
            if args.port != 0 && args.port != relay.port() {
                log::info!(
                    "collab: port changed {} -> {}, restarting relay",
                    relay.port(),
                    args.port
                );
                self.stop_locked(&mut inner).await;
            }
        }

        if inner.relay.is_none() {
            let hub = self.hub.clone();
            let on_peers: PeerCountFn = Arc::new(move |room: &str, count: usize| {
                hub.update(|s| {
                    if s.room_id.as_deref() == Some(room) {
                        s.peer_count = count;
                    }
                });
            });
            let relay = RelayServer::bind(args.port, self.assets.clone(), Some(on_peers))
                .await
                .map_err(|e| format!("relay_bind_failed: {e}"))?;
            let port = relay.port();
            inner.relay = Some(relay);
            self.hub.update(|s| {
                s.running = true;
                s.local_port = Some(port);
                s.local_base = Some(format!("http://127.0.0.1:{port}"));
            });
        }
        let inner = &mut *inner;
        let relay = inner.relay.as_ref().expect("relay running");
        let port = relay.port();

        if inner.room.as_deref() != Some(args.room_id.as_str()) {
            if let Some(old) = inner.room.take() {
                relay.close_room(&old);
            }
            relay.register_room(&args.room_id);
            inner.room = Some(args.room_id.clone());
            let count = relay.peer_count(&args.room_id);
            self.hub.update(|s| {
                s.room_id = Some(args.room_id.clone());
                s.peer_count = count;
            });
        }

        let cfg = (args.tunnel, manual.clone());
        let tunnel_errored = self.hub.get().tunnel.state == TunnelState::Error;
        if inner.tunnel_cfg.as_ref() != Some(&cfg) || tunnel_errored {
            if let Some(t) = inner.tunnel.take() {
                t.stop().await;
            }
            let gen = self.hub.next_gen();
            inner.tunnel_cfg = Some(cfg);
            match args.tunnel {
                TunnelMode::Local => {
                    self.hub.update(|s| {
                        s.public_base = s.local_base.clone();
                        s.tunnel = ready(TunnelMode::Local);
                    });
                }
                TunnelMode::Manual => {
                    self.hub.update(|s| {
                        s.public_base = manual.clone();
                        s.tunnel = ready(TunnelMode::Manual);
                    });
                }
                TunnelMode::Auto => {
                    self.hub.update(|s| {
                        s.public_base = None;
                        s.tunnel = TunnelStatus {
                            mode: Some(TunnelMode::Auto),
                            state: TunnelState::Starting,
                            error: None,
                        };
                    });
                    inner.tunnel = Some(self.spawn_devtunnel(gen, port));
                }
            }
        }

        Ok(self.hub.get())
    }

    fn spawn_devtunnel(&self, gen: u64, port: u16) -> TunnelTask {
        let hub = self.hub.clone();
        let id = self.tunnel_id.clone();
        let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            let started = tokio::select! {
                r = tunnel::start_devtunnel(&id, port) => r,
                _ = &mut stop_rx => return,
            };
            let mut host = match started {
                Ok(h) => h,
                Err(e) => {
                    log::warn!("collab: tunnel failed: {e}");
                    hub.update_tunnel(gen, |s| set_tunnel_error(s, e));
                    return;
                }
            };
            let url = host.public_base.clone();
            hub.update_tunnel(gen, |s| {
                s.public_base = Some(url);
                s.tunnel = ready(TunnelMode::Auto);
            });
            tokio::select! {
                reason = host.wait_exit() => {
                    log::warn!("collab: devtunnel host exited: {reason}");
                    hub.update_tunnel(gen, |s| set_tunnel_error(s, tunnel::err_failed(reason)));
                }
                _ = &mut stop_rx => host.stop().await,
            }
        });
        TunnelTask {
            stop: Some(stop_tx),
            task,
        }
    }

    /// Disconnect one peer from the active room (close 4001).
    pub async fn remove_peer(&self, client_id: &str) -> Result<(), String> {
        let inner = self.inner.lock().await;
        let (Some(relay), Some(room)) = (inner.relay.as_ref(), inner.room.as_deref()) else {
            return Err("no active session".to_owned());
        };
        if relay.kick_peer(room, client_id) {
            Ok(())
        } else {
            Err(format!("unknown peer {client_id}"))
        }
    }

    pub async fn stop(&self) -> CollabStatus {
        let mut inner = self.inner.lock().await;
        self.stop_locked(&mut inner).await;
        self.hub.get()
    }

    async fn stop_locked(&self, inner: &mut Inner) {
        self.hub.next_gen();
        if let Some(t) = inner.tunnel.take() {
            t.stop().await;
        }
        if let Some(relay) = inner.relay.take() {
            relay.shutdown().await;
        }
        inner.room = None;
        inner.tunnel_cfg = None;
        self.hub.update(|s| *s = CollabStatus::off());
    }
}

fn ready(mode: TunnelMode) -> TunnelStatus {
    TunnelStatus {
        mode: Some(mode),
        state: TunnelState::Ready,
        error: None,
    }
}

fn set_tunnel_error(s: &mut CollabStatus, error: String) {
    s.public_base = None;
    s.tunnel.state = TunnelState::Error;
    s.tunnel.error = Some(error);
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOM: &str = "0123456789abcdef0123";

    fn manager() -> (CollabManager, Arc<Mutex<Vec<CollabStatus>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let emit: EmitFn = Arc::new(move |s: &CollabStatus| sink.lock().unwrap().push(s.clone()));
        (CollabManager::new(emit, None, Some("test")), events)
    }

    #[test]
    fn status_serializes_to_ts_shape() {
        let json = serde_json::to_value(CollabStatus::off()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "running": false, "roomId": null, "localPort": null, "localBase": null,
                "publicBase": null,
                "tunnel": { "mode": null, "state": "off", "error": null },
                "peerCount": 0
            })
        );
        let args: CollabStartArgs = serde_json::from_value(serde_json::json!({
            "roomId": ROOM, "port": 0, "tunnel": "manual", "manualUrl": "https://x.dev/"
        }))
        .unwrap();
        assert_eq!(args.tunnel, TunnelMode::Manual);
        assert_eq!(args.manual_url.as_deref(), Some("https://x.dev/"));
    }

    #[tokio::test]
    async fn local_mode_lifecycle() {
        let (m, events) = manager();
        let s = m
            .start(CollabStartArgs {
                room_id: ROOM.into(),
                port: 0,
                tunnel: TunnelMode::Local,
                manual_url: None,
            })
            .await
            .unwrap();
        assert!(s.running);
        let port = s.local_port.unwrap();
        assert_ne!(port, 0);
        assert_eq!(
            s.local_base.as_deref(),
            Some(&*format!("http://127.0.0.1:{port}"))
        );
        assert_eq!(s.public_base, s.local_base);
        assert_eq!(s.tunnel.state, TunnelState::Ready);
        assert_eq!(s.room_id.as_deref(), Some(ROOM));

        // Idempotent: same args → no new events.
        let n = events.lock().unwrap().len();
        let again = m
            .start(CollabStartArgs {
                room_id: ROOM.into(),
                port: 0,
                tunnel: TunnelMode::Local,
                manual_url: None,
            })
            .await
            .unwrap();
        assert_eq!(again, s);
        assert_eq!(events.lock().unwrap().len(), n);

        // Switch to manual without restarting the relay.
        let s2 = m
            .start(CollabStartArgs {
                room_id: ROOM.into(),
                port: 0,
                tunnel: TunnelMode::Manual,
                manual_url: Some("https://example.com/".into()),
            })
            .await
            .unwrap();
        assert_eq!(s2.local_port, Some(port));
        assert_eq!(s2.public_base.as_deref(), Some("https://example.com"));

        let off = m.stop().await;
        assert_eq!(off, CollabStatus::off());
        assert_eq!(events.lock().unwrap().last(), Some(&CollabStatus::off()));
    }

    #[tokio::test]
    async fn rejects_bad_args() {
        let (m, _) = manager();
        let bad_room = m
            .start(CollabStartArgs {
                room_id: "nope".into(),
                port: 0,
                tunnel: TunnelMode::Local,
                manual_url: None,
            })
            .await;
        assert!(bad_room.is_err());
        let bad_url = m
            .start(CollabStartArgs {
                room_id: ROOM.into(),
                port: 0,
                tunnel: TunnelMode::Manual,
                manual_url: None,
            })
            .await;
        assert!(bad_url.is_err());
        assert_eq!(m.status(), CollabStatus::off());
    }

    /// Live smoke against the real `devtunnel` CLI (needs login + network).
    /// Run with `cargo test -- --ignored live_devtunnel`; creates/reuses the
    /// tunnel `excalidraw-desktop-test`.
    #[tokio::test]
    #[ignore]
    async fn live_devtunnel_auto_mode() {
        let (m, _) = manager();
        let s = m
            .start(CollabStartArgs {
                room_id: ROOM.into(),
                port: 0,
                tunnel: TunnelMode::Auto,
                manual_url: None,
            })
            .await
            .unwrap();
        assert_eq!(s.tunnel.state, TunnelState::Starting);
        assert_eq!(s.public_base, None);
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(90);
        let s = loop {
            let s = m.status();
            if s.tunnel.state != TunnelState::Starting || tokio::time::Instant::now() > deadline {
                break s;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        };
        println!("live status: {}", serde_json::to_string(&s).unwrap());
        assert_eq!(s.tunnel.state, TunnelState::Ready, "{:?}", s.tunnel.error);
        let base = s.public_base.clone().unwrap();
        assert!(base.starts_with("https://") && base.contains(".devtunnels.ms"));
        m.stop().await;
        assert!(!m.status().running);
    }
}

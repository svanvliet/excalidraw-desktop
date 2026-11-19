//! Runs the production collab relay outside the app so Playwright can drive
//! browser guests against it (see `npm run e2e:rust-relay`).
//!
//! `cargo run --example relay_standalone -- --port 4174 --dist ../dist \
//!     --room <20 hex> [--control-port 4175] [--guest-role editor|viewer]`
//!
//! There is no host here, so guests default to `editor` unless
//! `--guest-role viewer` is given.
//!
//! The optional control port exposes test-only `POST /__end/<room>`, which
//! closes the room with 4000 like a host pressing "Stop session".
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::routing::post;
use axum::Router;
use excalidraw_desktop_lib::collab::protocol::Role;
use excalidraw_desktop_lib::collab::relay::{Asset, AssetSource, RelayServer};

struct DirAssets(PathBuf);

impl AssetSource for DirAssets {
    fn get(&self, path: &str) -> Option<Asset> {
        let bytes = std::fs::read(self.0.join(path)).ok()?;
        Some(Asset {
            bytes,
            mime: String::new(),
        })
    }
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let port: u16 = arg(&args, "--port")
        .and_then(|p| p.parse().ok())
        .unwrap_or(4174);
    let dist = PathBuf::from(arg(&args, "--dist").unwrap_or_else(|| "../dist".into()));
    let relay = Arc::new(RelayServer::bind(port, Some(Arc::new(DirAssets(dist))), None).await?);
    let guest_role = match arg(&args, "--guest-role").as_deref() {
        Some("viewer") => Role::Viewer,
        _ => Role::Editor,
    };
    for room in args.windows(2).filter(|w| w[0] == "--room").map(|w| &w[1]) {
        relay.register_room(room, None);
        relay.set_guest_default_role(room, guest_role);
    }
    println!("relay_standalone: listening on 127.0.0.1:{}", relay.port());

    if let Some(cp) = arg(&args, "--control-port").and_then(|p| p.parse::<u16>().ok()) {
        let app = Router::new()
            .route(
                "/__end/{room}",
                post(
                    |State(r): State<Arc<RelayServer>>, Path(room): Path<String>| async move {
                        r.close_room(&room);
                        axum::http::StatusCode::NO_CONTENT
                    },
                ),
            )
            .with_state(relay.clone());
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", cp)).await?;
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
    }

    tokio::signal::ctrl_c().await
}

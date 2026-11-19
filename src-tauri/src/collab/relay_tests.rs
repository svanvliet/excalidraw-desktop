use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::Message as WsMsg;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use super::*;

type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;

const ROOM: &str = "0123456789abcdef0123";
const TIMEOUT: Duration = Duration::from_secs(5);

struct FakeAssets;
impl AssetSource for FakeAssets {
    fn get(&self, path: &str) -> Option<Asset> {
        match path {
            "index.html" => Some(Asset {
                bytes: b"<!doctype html>".to_vec(),
                mime: "text/html".into(),
            }),
            "assets/app.js" => Some(Asset {
                bytes: b"console.log(1)".to_vec(),
                mime: String::new(),
            }),
            _ => None,
        }
    }
}

async fn server() -> RelayServer {
    let s = RelayServer::bind(0, Some(Arc::new(FakeAssets)), None)
        .await
        .unwrap();
    s.register_room(ROOM, Some(HOST_TOKEN));
    s
}

const HOST_TOKEN: &str = "0123456789abcdef0123456789abcdef";

async fn connect(port: u16) -> Client {
    let (ws, _) = connect_async(format!("ws://127.0.0.1:{port}/ws"))
        .await
        .unwrap();
    ws
}

async fn send(c: &mut Client, v: Value) {
    c.send(WsMsg::Text(v.to_string().into())).await.unwrap();
}

/// Next text frame as JSON (skipping pings).
async fn recv(c: &mut Client) -> Value {
    loop {
        let msg = tokio::time::timeout(TIMEOUT, c.next())
            .await
            .expect("timed out waiting for frame")
            .expect("stream ended")
            .expect("ws error");
        match msg {
            WsMsg::Text(t) => return serde_json::from_str(t.as_str()).unwrap(),
            WsMsg::Close(f) => panic!("unexpected close: {f:?}"),
            _ => continue,
        }
    }
}

/// Wait for the close frame and return its code.
async fn recv_close(c: &mut Client) -> u16 {
    loop {
        let msg = tokio::time::timeout(TIMEOUT, c.next())
            .await
            .expect("timed out waiting for close");
        match msg {
            Some(Ok(WsMsg::Close(Some(f)))) => return u16::from(f.code),
            Some(Ok(WsMsg::Close(None))) | None => return 0,
            Some(Ok(_)) => continue,
            Some(Err(e)) => panic!("ws error: {e}"),
        }
    }
}

async fn join(port: u16) -> (Client, String, Value) {
    join_with(port, json!({"type":"join","room":ROOM,"protocol":1})).await
}

async fn join_with(port: u16, frame: Value) -> (Client, String, Value) {
    let mut c = connect(port).await;
    send(&mut c, frame).await;
    let welcome = recv(&mut c).await;
    assert_eq!(welcome["type"], "welcome");
    let id = welcome["clientId"].as_str().unwrap().to_owned();
    assert_eq!(id.len(), 16);
    let peers = recv(&mut c).await;
    assert_eq!(peers["type"], "peers");
    (c, id, welcome)
}

#[tokio::test]
async fn join_welcome_and_peer_updates() {
    let s = server().await;
    let (mut a, a_id, wa) = join(s.port()).await;
    assert_eq!(wa["firstInRoom"], true);
    assert_eq!(wa["peers"], json!([]));

    let (mut b, b_id, wb) = join(s.port()).await;
    assert_eq!(wb["firstInRoom"], false);
    assert_eq!(wb["peers"], json!([a_id]));
    let pa = recv(&mut a).await;
    assert_eq!(pa["peers"], json!([a_id, b_id]));
    assert_eq!(pa["roles"], json!({&a_id: "viewer", &b_id: "viewer"}));
    assert_eq!(s.peer_count(ROOM), 2);

    b.close(None).await.unwrap();
    let pa = recv(&mut a).await;
    assert_eq!(pa["peers"], json!([a_id]));
    assert_eq!(s.peer_count(ROOM), 1);
}

#[tokio::test]
async fn fan_out_excludes_sender() {
    let s = server().await;
    let (mut a, a_id, _) = join(s.port()).await;
    let (mut b, _, _) = join(s.port()).await;
    let _ = recv(&mut a).await; // peers update for b
    let (mut c, _, _) = join(s.port()).await;
    let _ = recv(&mut a).await;
    let _ = recv(&mut b).await;

    send(
        &mut a,
        json!({"type":"broadcast","volatile":false,"iv":"aXY=","data":"ZGF0YQ=="}),
    )
    .await;
    let expected =
        json!({"type":"message","from":a_id,"volatile":false,"iv":"aXY=","data":"ZGF0YQ=="});
    assert_eq!(recv(&mut b).await, expected);
    assert_eq!(recv(&mut c).await, expected);

    // Sender must not receive its own message: the next thing `a` sees is
    // b's broadcast.
    send(
        &mut b,
        json!({"type":"broadcast","volatile":true,"iv":"","data":"eA=="}),
    )
    .await;
    let got = recv(&mut a).await;
    assert_eq!(got["data"], "eA==");
    assert_eq!(got["volatile"], true);
}

#[tokio::test]
async fn unknown_room_rejected() {
    let s = server().await;
    let mut c = connect(s.port()).await;
    send(
        &mut c,
        json!({"type":"join","room":"ffffffffffffffffffff","protocol":1}),
    )
    .await;
    let err = recv(&mut c).await;
    assert_eq!(err["type"], "error");
    assert_eq!(err["code"], "unknown_room");
    assert_eq!(recv_close(&mut c).await, CLOSE_POLICY);
}

#[tokio::test]
async fn protocol_errors() {
    let s = server().await;
    // broadcast before join
    let mut c = connect(s.port()).await;
    send(
        &mut c,
        json!({"type":"broadcast","volatile":false,"iv":"","data":""}),
    )
    .await;
    assert_eq!(recv(&mut c).await["code"], "protocol");
    assert_eq!(recv_close(&mut c).await, CLOSE_POLICY);

    // wrong protocol version
    let mut c = connect(s.port()).await;
    send(&mut c, json!({"type":"join","room":ROOM,"protocol":2})).await;
    assert_eq!(recv(&mut c).await["code"], "protocol");
    assert_eq!(recv_close(&mut c).await, CLOSE_POLICY);

    // unknown type keeps the connection; malformed JSON closes with 1003
    let (mut c, _, _) = join(s.port()).await;
    send(&mut c, json!({"type":"wat"})).await;
    assert_eq!(recv(&mut c).await["code"], "bad_frame");
    c.send(WsMsg::Text("{not json".into())).await.unwrap();
    assert_eq!(recv_close(&mut c).await, CLOSE_UNSUPPORTED_DATA);
}

#[tokio::test]
async fn room_full() {
    let s = server().await;
    let mut clients = Vec::new();
    for _ in 0..MAX_PEERS_PER_ROOM {
        let (c, _, _) = join(s.port()).await;
        clients.push(c);
    }
    assert_eq!(s.peer_count(ROOM), MAX_PEERS_PER_ROOM);
    let mut extra = connect(s.port()).await;
    send(&mut extra, json!({"type":"join","room":ROOM,"protocol":1})).await;
    let err = recv(&mut extra).await;
    assert_eq!(err["code"], "room_full");
    assert_eq!(recv_close(&mut extra).await, CLOSE_POLICY);
}

#[tokio::test]
async fn too_large_frame_rejected_but_connection_kept() {
    let s = server().await;
    let (mut a, _, _) = join(s.port()).await;
    let (mut b, _, _) = join(s.port()).await;
    let _ = recv(&mut a).await;

    let big = "A".repeat(MAX_FRAME_BYTES + 1);
    send(
        &mut a,
        json!({"type":"broadcast","volatile":false,"iv":"","data":big}),
    )
    .await;
    assert_eq!(recv(&mut a).await["code"], "too_large");

    // Still usable afterwards, and b never got the oversized frame.
    send(
        &mut a,
        json!({"type":"broadcast","volatile":false,"iv":"","data":"ok"}),
    )
    .await;
    assert_eq!(recv(&mut b).await["data"], "ok");
}

#[tokio::test]
async fn close_room_sends_4000_to_everyone() {
    let s = server().await;
    let (mut a, _, _) = join(s.port()).await;
    let (mut b, _, _) = join(s.port()).await;
    let _ = recv(&mut a).await;
    s.shutdown().await;
    assert_eq!(recv_close(&mut a).await, CLOSE_SESSION_ENDED);
    assert_eq!(recv_close(&mut b).await, CLOSE_SESSION_ENDED);
    assert_eq!(u16::from(CloseCode::from(4000)), 4000);
}

#[tokio::test]
async fn kick_peer_closes_only_that_peer_with_4001() {
    let s = server().await;
    let (mut a, a_id, _) = join(s.port()).await;
    let (mut b, b_id, _) = join(s.port()).await;
    let _ = recv(&mut a).await;
    assert!(!s.kick_peer(ROOM, "0000000000000000"));
    assert!(s.kick_peer(ROOM, &b_id));
    assert_eq!(recv_close(&mut b).await, CLOSE_REMOVED);
    let pa = recv(&mut a).await;
    assert_eq!(pa["peers"], json!([a_id]));
    assert_eq!(s.peer_count(ROOM), 1);
}

#[tokio::test]
async fn host_token_grants_host_and_guests_default_to_viewer() {
    let s = server().await;
    let (mut h, h_id, wh) = join_with(
        s.port(),
        json!({"type":"join","room":ROOM,"protocol":1,"hostToken":HOST_TOKEN}),
    )
    .await;
    assert_eq!(wh["roles"][&h_id], "host");
    let (_fake, f_id, wf) = join_with(
        s.port(),
        json!({"type":"join","room":ROOM,"protocol":1,"hostToken":"nope"}),
    )
    .await;
    assert_eq!(wf["roles"][&f_id], "viewer");
    assert_eq!(wf["roles"][&h_id], "host");
    assert_eq!(recv(&mut h).await["roles"][&f_id], "viewer");
}

#[tokio::test]
async fn set_role_rebroadcasts_and_survives_resume() {
    let s = server().await;
    let (mut h, h_id, _) = join_with(
        s.port(),
        json!({"type":"join","room":ROOM,"protocol":1,"hostToken":HOST_TOKEN}),
    )
    .await;
    let (mut g, g_id, wg) = join(s.port()).await;
    let token = wg["resumeToken"].as_str().unwrap().to_owned();
    assert_eq!(token.len(), 32);
    let _ = recv(&mut h).await;

    assert!(!s.set_role(ROOM, &h_id, Role::Viewer), "host role is fixed");
    assert!(!s.set_role(ROOM, &g_id, Role::Host));
    assert!(!s.set_role(ROOM, "0000000000000000", Role::Editor));
    assert!(s.set_role(ROOM, &g_id, Role::Editor));
    assert_eq!(recv(&mut h).await["roles"][&g_id], "editor");
    assert_eq!(recv(&mut g).await["roles"][&g_id], "editor");

    g.close(None).await.unwrap();
    let _ = recv(&mut h).await;
    let (_g2, g2_id, wg2) = join_with(
        s.port(),
        json!({"type":"join","room":ROOM,"protocol":1,"resume":token}),
    )
    .await;
    assert_eq!(wg2["roles"][&g2_id], "editor");
    assert_eq!(wg2["resumeToken"], token.as_str());
    let (_g3, g3_id, wg3) = join_with(
        s.port(),
        json!({"type":"join","room":ROOM,"protocol":1,"resume":"bogus"}),
    )
    .await;
    assert_eq!(wg3["roles"][&g3_id], "viewer");
}

#[tokio::test]
async fn peer_count_callback_fires() {
    let counts = Arc::new(Mutex::new(Vec::new()));
    let sink = counts.clone();
    let cb: PeerCountFn = Arc::new(move |room: &str, n: usize| {
        sink.lock().unwrap().push((room.to_owned(), n));
    });
    let s = RelayServer::bind(0, None, Some(cb)).await.unwrap();
    s.register_room(ROOM, None);
    let (a, _, _) = join(s.port()).await;
    let (b, _, _) = join(s.port()).await;
    drop(b);
    tokio::time::sleep(Duration::from_millis(200)).await;
    s.close_room(ROOM);
    drop(a);
    let got: Vec<usize> = counts.lock().unwrap().iter().map(|(_, n)| *n).collect();
    assert_eq!(got, vec![1, 2, 1, 0]);
}

async fn http_get(port: u16, path: &str) -> (u16, String, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut buf = String::new();
    s.read_to_string(&mut buf).await.unwrap();
    let (head, body) = buf.split_once("\r\n\r\n").unwrap();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    (status, head.to_ascii_lowercase(), body.to_owned())
}

#[tokio::test]
async fn serves_assets_healthz_and_spa_fallback() {
    let s = server().await;
    let (st, _, body) = http_get(s.port(), "/healthz").await;
    assert_eq!((st, body.as_str()), (200, r#"{"ok":true,"protocol":1}"#));

    let (st, head, body) = http_get(s.port(), "/").await;
    assert_eq!(st, 200);
    assert!(head.contains("content-type: text/html"));
    assert!(head.contains("content-security-policy: default-src 'self'"));
    assert_eq!(body, "<!doctype html>");

    let (st, head, _) = http_get(s.port(), "/assets/app.js").await;
    assert_eq!(st, 200);
    assert!(
        head.contains("content-type: text/javascript") || head.contains("application/javascript")
    );

    let (st, _, body) = http_get(s.port(), "/some/route").await;
    assert_eq!((st, body.as_str()), (200, "<!doctype html>"));
    assert_eq!(http_get(s.port(), "/missing.js").await.0, 404);
    assert_eq!(http_get(s.port(), "/../etc/passwd").await.0, 404);
}

#[tokio::test]
async fn no_assets_returns_503() {
    let s = RelayServer::bind(0, None, None).await.unwrap();
    assert_eq!(http_get(s.port(), "/").await.0, 503);
}

#[test]
fn asset_keys() {
    assert_eq!(asset_key("/").as_deref(), Some("index.html"));
    assert_eq!(asset_key("/a/b.js").as_deref(), Some("a/b.js"));
    assert_eq!(asset_key("/dir/").as_deref(), Some("dir/index.html"));
    assert_eq!(asset_key("/../x"), None);
    assert_eq!(asset_key("/a/./b"), None);
}

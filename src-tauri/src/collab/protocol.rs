//! Wire protocol for the collab relay (docs/collab-protocol.md §3).
//!
//! Pure data + parsing so it can be unit-tested without sockets.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u64 = 1;
/// Max accepted text frame (JSON) size.
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
/// Hard transport cap. Frames between `MAX_FRAME_BYTES` and this get a
/// `too_large` error (connection kept); larger ones kill the socket.
pub const HARD_FRAME_BYTES: usize = 2 * MAX_FRAME_BYTES;
pub const MAX_PEERS_PER_ROOM: usize = 32;
/// Close code sent to every peer when the host ends the session.
pub const CLOSE_SESSION_ENDED: u16 = 4000;
/// The host removed this peer from the room.
pub const CLOSE_REMOVED: u16 = 4001;
/// Close code after `unknown_room` / `room_full` / `protocol` errors.
pub const CLOSE_POLICY: u16 = 1008;
/// Close code for malformed JSON.
pub const CLOSE_UNSUPPORTED_DATA: u16 = 1003;
/// Close code when a peer can't keep up with reliable traffic.
pub const CLOSE_TRY_AGAIN_LATER: u16 = 1013;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientFrame {
    Join {
        room: String,
        protocol: u64,
    },
    Broadcast {
        volatile: bool,
        iv: String,
        data: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    UnknownRoom,
    RoomFull,
    BadFrame,
    TooLarge,
    Protocol,
}

impl ErrorCode {
    /// Whether the relay closes the socket after sending this error.
    pub fn is_fatal(self) -> bool {
        matches!(
            self,
            ErrorCode::UnknownRoom | ErrorCode::RoomFull | ErrorCode::Protocol
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerFrame<'a> {
    #[serde(rename_all = "camelCase")]
    Welcome {
        client_id: &'a str,
        peers: Vec<&'a str>,
        first_in_room: bool,
    },
    Peers {
        peers: Vec<&'a str>,
    },
    Message {
        from: &'a str,
        volatile: bool,
        iv: &'a str,
        data: &'a str,
    },
    Error {
        code: ErrorCode,
        message: &'a str,
    },
}

impl ServerFrame<'_> {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("server frames always serialize")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// Not JSON / not an object → close 1003.
    Malformed,
    /// Valid JSON but unknown `type` or bad fields → `bad_frame`, keep socket.
    BadFrame(String),
}

#[derive(Deserialize)]
struct JoinFields {
    room: String,
    protocol: u64,
}

#[derive(Deserialize)]
struct BroadcastFields {
    volatile: bool,
    iv: String,
    data: String,
}

pub fn parse_client_frame(text: &str) -> Result<ClientFrame, ParseError> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|_| ParseError::Malformed)?;
    let ty = value
        .as_object()
        .ok_or(ParseError::Malformed)?
        .get("type")
        .and_then(|t| t.as_str())
        .ok_or_else(|| ParseError::BadFrame("missing type".into()))?
        .to_owned();
    match ty.as_str() {
        "join" => {
            let f: JoinFields = serde_json::from_value(value)
                .map_err(|e| ParseError::BadFrame(format!("join: {e}")))?;
            Ok(ClientFrame::Join {
                room: f.room,
                protocol: f.protocol,
            })
        }
        "broadcast" => {
            let f: BroadcastFields = serde_json::from_value(value)
                .map_err(|e| ParseError::BadFrame(format!("broadcast: {e}")))?;
            Ok(ClientFrame::Broadcast {
                volatile: f.volatile,
                iv: f.iv,
                data: f.data,
            })
        }
        other => Err(ParseError::BadFrame(format!("unknown type: {other}"))),
    }
}

/// `roomId`: 20 lowercase hex chars (§2).
pub fn is_valid_room_id(room: &str) -> bool {
    room.len() == 20 && room.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Relay-assigned client id: 16 lowercase hex chars.
pub fn new_client_id() -> String {
    format!("{:016x}", rand::random::<u64>())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_join_and_broadcast() {
        assert_eq!(
            parse_client_frame(r#"{"type":"join","room":"abc","protocol":1}"#),
            Ok(ClientFrame::Join {
                room: "abc".into(),
                protocol: 1
            })
        );
        assert_eq!(
            parse_client_frame(r#"{"type":"broadcast","volatile":true,"iv":"a","data":"b"}"#),
            Ok(ClientFrame::Broadcast {
                volatile: true,
                iv: "a".into(),
                data: "b".into()
            })
        );
    }

    #[test]
    fn malformed_vs_bad_frame() {
        assert_eq!(parse_client_frame("not json"), Err(ParseError::Malformed));
        assert_eq!(parse_client_frame("[1,2]"), Err(ParseError::Malformed));
        assert!(matches!(
            parse_client_frame(r#"{"type":"nope"}"#),
            Err(ParseError::BadFrame(_))
        ));
        assert!(matches!(
            parse_client_frame(r#"{"type":"broadcast","volatile":"x"}"#),
            Err(ParseError::BadFrame(_))
        ));
    }

    #[test]
    fn server_frames_use_camel_case() {
        let json = ServerFrame::Welcome {
            client_id: "c1",
            peers: vec!["c0"],
            first_in_room: false,
        }
        .to_json();
        assert_eq!(
            json,
            r#"{"type":"welcome","clientId":"c1","peers":["c0"],"firstInRoom":false}"#
        );
        let err = ServerFrame::Error {
            code: ErrorCode::UnknownRoom,
            message: "m",
        }
        .to_json();
        assert_eq!(
            err,
            r#"{"type":"error","code":"unknown_room","message":"m"}"#
        );
    }

    #[test]
    fn room_id_validation() {
        assert!(is_valid_room_id("0123456789abcdef0123"));
        assert!(!is_valid_room_id("0123456789ABCDEF0123"));
        assert!(!is_valid_room_id("0123"));
        assert_eq!(new_client_id().len(), 16);
    }
}

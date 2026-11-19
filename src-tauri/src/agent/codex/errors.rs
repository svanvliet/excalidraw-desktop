//! Map Codex failures onto the canonical [`ErrorKind`] / [`StopReason`].
//!
//! Portions adapted from T3 Code (https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc., MIT License.
//! (`CodexAdapterV2.ts` error classification, `codexUsageLimits.ts`, CODEX_HOME writer conflict.)
use super::protocol::{RpcError, TurnError, RPC_INVALID_REQUEST};
use crate::agent::events::{ErrorKind, StopReason};
use serde_json::Value;

/// The `codexErrorInfo` code: a bare string, or the single key of an object variant.
fn info_code(info: Option<&Value>) -> Option<&str> {
    match info? {
        Value::String(s) => Some(s.as_str()),
        Value::Object(m) => m.keys().next().map(String::as_str),
        _ => None,
    }
}

fn info_http_status(info: Option<&Value>) -> Option<u64> {
    info?
        .as_object()?
        .values()
        .next()?
        .get("httpStatusCode")?
        .as_u64()
}

fn message_kind(message: &str) -> Option<ErrorKind> {
    let m = message.to_ascii_lowercase();
    let auth = [
        "not logged in",
        "codex login",
        "unauthorized",
        "401",
        "authentication",
        "refresh token",
        "sign in again",
    ];
    if auth.iter().any(|p| m.contains(p)) {
        return Some(ErrorKind::NotLoggedIn);
    }
    let quota = [
        "usage limit",
        "rate limit",
        "quota",
        "429",
        "too many requests",
    ];
    if quota.iter().any(|p| m.contains(p)) {
        return Some(ErrorKind::QuotaExceeded);
    }
    if m.contains("workspace") && (m.contains("disabled") || m.contains("not allowed")) {
        return Some(ErrorKind::OrgDisabled);
    }
    None
}

pub fn classify(message: &str, info: Option<&Value>) -> ErrorKind {
    match info_code(info) {
        Some(
            "usageLimitExceeded"
            | "rateLimitExceeded"
            | "sessionBudgetExceeded"
            | "apiKeySpendLimitExceeded"
            | "projectSpendLimitExceeded"
            | "organizationSpendLimitExceeded",
        ) => return ErrorKind::QuotaExceeded,
        Some("unauthorized") => return ErrorKind::NotLoggedIn,
        _ => {}
    }
    match info_http_status(info) {
        Some(401 | 403) => return ErrorKind::NotLoggedIn,
        Some(429) => return ErrorKind::QuotaExceeded,
        _ => {}
    }
    message_kind(message).unwrap_or(ErrorKind::Other)
}

pub fn classify_turn_error(err: &TurnError) -> ErrorKind {
    classify(&err.message, err.codex_error_info.as_ref())
}

pub fn turn_error_message(err: &TurnError) -> String {
    match err.additional_details.as_deref() {
        Some(d) if !d.trim().is_empty() => format!("{}\n{}", err.message, d.trim()),
        _ => err.message.clone(),
    }
}

/// Policy blocks end the turn as a refusal rather than an error.
pub fn stop_reason_for_failure(err: Option<&TurnError>) -> StopReason {
    match err.and_then(|e| info_code(e.codex_error_info.as_ref())) {
        Some(
            "cyberPolicy" | "bioPolicy" | "misalignmentPolicyViolation" | "inferenceHookDenied",
        ) => StopReason::Refusal,
        _ => StopReason::Error,
    }
}

/// Another Codex client (CLI/IDE) holds the write lock on this thread's rollout under CODEX_HOME.
pub fn is_writer_conflict(err: &RpcError) -> bool {
    err.code == RPC_INVALID_REQUEST && err.message.contains("already has an active writer")
}

pub const WRITER_CONFLICT_MESSAGE: &str =
    "This conversation is open in another Codex client (CLI, IDE or app). \
Quit that client, then send your message again.";

/// Stderr lines worth surfacing; everything else is just logged by the manager.
pub fn classify_stderr(line: &str) -> Option<ErrorKind> {
    let m = line.to_ascii_lowercase();
    if m.contains("not logged in") || m.contains("codex login") || m.contains("401 unauthorized") {
        return Some(ErrorKind::NotLoggedIn);
    }
    if m.contains("usage limit") || m.contains("429 too many requests") {
        return Some(ErrorKind::QuotaExceeded);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codes_and_http_statuses_map_to_kinds() {
        assert_eq!(
            classify("x", Some(&json!("usageLimitExceeded"))),
            ErrorKind::QuotaExceeded
        );
        assert_eq!(
            classify("x", Some(&json!("unauthorized"))),
            ErrorKind::NotLoggedIn
        );
        assert_eq!(
            classify(
                "x",
                Some(&json!({"responseTooManyFailedAttempts": {"httpStatusCode": 429}}))
            ),
            ErrorKind::QuotaExceeded
        );
        assert_eq!(
            classify(
                "x",
                Some(&json!({"httpConnectionFailed": {"httpStatusCode": 401}}))
            ),
            ErrorKind::NotLoggedIn
        );
        assert_eq!(
            classify("You've hit your usage limit.", None),
            ErrorKind::QuotaExceeded
        );
        assert_eq!(
            classify("Not logged in. Run codex login", Some(&json!("other"))),
            ErrorKind::NotLoggedIn
        );
        assert_eq!(
            classify(
                "context window exceeded",
                Some(&json!("contextWindowExceeded"))
            ),
            ErrorKind::Other
        );
    }

    #[test]
    fn policy_failures_are_refusals() {
        let e = TurnError {
            message: "blocked".into(),
            codex_error_info: Some(json!("cyberPolicy")),
            additional_details: None,
        };
        assert_eq!(stop_reason_for_failure(Some(&e)), StopReason::Refusal);
        assert_eq!(stop_reason_for_failure(None), StopReason::Error);
    }

    #[test]
    fn detects_codex_home_writer_conflict() {
        let e = RpcError {
            code: -32600,
            message: "thread abc already has an active writer".into(),
            data: None,
        };
        assert!(is_writer_conflict(&e));
    }
}

//! DevTunnels orchestration (docs/collab-protocol.md §5) plus manual-URL
//! validation. Parsers are pure functions; the async part drives the
//! `devtunnel` CLI with `tokio::process`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

pub const ERR_NOT_INSTALLED: &str = "devtunnel_not_installed";
pub const ERR_NOT_LOGGED_IN: &str = "devtunnel_not_logged_in";

pub fn err_failed(detail: impl AsRef<str>) -> String {
    format!("devtunnel_failed: {}", detail.as_ref().trim())
}

const CLI_TIMEOUT: Duration = Duration::from_secs(45);
const HOST_READY_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelMode {
    Auto,
    Manual,
    Local,
}

/// Persistent tunnel id: `excalidraw-desktop` or `excalidraw-desktop-<profile>`.
pub fn tunnel_id(profile: Option<&str>) -> String {
    match profile {
        Some(p) if !p.is_empty() => {
            let slug: String = p
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() {
                        c.to_ascii_lowercase()
                    } else {
                        '-'
                    }
                })
                .collect();
            format!("excalidraw-desktop-{}", slug.trim_matches('-'))
        }
        _ => "excalidraw-desktop".to_owned(),
    }
}

/// Validate a user-supplied public base URL (manual mode). Returns it with
/// trailing slashes trimmed.
pub fn validate_manual_url(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .ok_or_else(|| "manual URL must start with http:// or https://".to_owned())?;
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("manual URL must not contain whitespace".to_owned());
    }
    if url.contains('#') || url.contains('?') {
        return Err("manual URL must not contain a query or fragment".to_owned());
    }
    let host = rest.split('/').next().unwrap_or("");
    let hostname = host.rsplit_once('@').map_or(host, |(_, h)| h);
    if host.contains('@') {
        return Err("manual URL must not contain credentials".to_owned());
    }
    if hostname.is_empty() || hostname.starts_with(':') {
        return Err("manual URL is missing a host".to_owned());
    }
    Ok(url.trim_end_matches('/').to_owned())
}

/// `devtunnel user show` prints "Logged in as …" or "Not logged in.".
pub fn parse_logged_in(user_show_output: &str) -> bool {
    let lower = user_show_output.to_ascii_lowercase();
    lower.contains("logged in as") && !lower.contains("not logged in")
}

/// Heuristic for auth failures in CLI error output.
pub fn looks_like_auth_error(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    [
        "not logged in",
        "login required",
        "unauthorized",
        "please log in",
        "401",
    ]
    .iter()
    .any(|s| lower.contains(s))
}

pub fn is_not_found(output: &str) -> bool {
    output.to_ascii_lowercase().contains("not found")
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TunnelInfo {
    pub ports: Vec<(u16, Option<String>)>,
    pub anonymous: bool,
}

/// Parse `devtunnel show <id> -j`.
pub fn parse_show_json(json: &str) -> Result<TunnelInfo, String> {
    #[derive(Deserialize)]
    struct Root {
        tunnel: Tunnel,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Tunnel {
        #[serde(default)]
        ports: Vec<Port>,
        #[serde(default)]
        access_control: Vec<Ace>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Port {
        port_number: u16,
        port_uri: Option<String>,
    }
    #[derive(Deserialize)]
    struct Ace {
        #[serde(rename = "type")]
        ty: String,
        #[serde(default)]
        scopes: Vec<String>,
        #[serde(rename = "isDeny", default)]
        is_deny: bool,
    }
    let start = json.find('{').ok_or("no JSON in devtunnel show output")?;
    let root: Root = serde_json::from_str(&json[start..]).map_err(|e| e.to_string())?;
    Ok(TunnelInfo {
        ports: root
            .tunnel
            .ports
            .into_iter()
            .map(|p| (p.port_number, p.port_uri))
            .collect(),
        anonymous: root.tunnel.access_control.iter().any(|a| {
            a.ty.eq_ignore_ascii_case("anonymous")
                && !a.is_deny
                && a.scopes.iter().any(|s| s == "connect")
        }),
    })
}

/// Extract the public URL for `port` from a `devtunnel host` output line,
/// e.g. `Connect via browser: https://drhbf9kg-4780.usw3.devtunnels.ms`.
pub fn parse_host_url(line: &str, port: u16) -> Option<String> {
    let (_, urls) = line.split_once("Connect via browser:")?;
    let candidates: Vec<&str> = urls
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|s| s.starts_with("https://"))
        .collect();
    let suffix = format!("-{port}");
    candidates
        .iter()
        .find(|u| {
            let host = u.trim_start_matches("https://").split(['/', '.']).next();
            host.is_some_and(|h| h.ends_with(&suffix))
        })
        .or_else(|| candidates.first())
        .map(|u| u.trim_end_matches('/').to_owned())
}

pub fn is_host_ready(line: &str) -> bool {
    line.contains("Ready to accept connections")
}

/// Locate the `devtunnel` binary. GUI apps on macOS get a minimal PATH, so
/// well-known install locations are checked too.
pub fn find_devtunnel() -> Option<PathBuf> {
    let exe = if cfg!(windows) {
        "devtunnel.exe"
    } else {
        "devtunnel"
    };
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&path_var).collect();
    dirs.extend(extra_search_dirs());
    find_in_dirs(exe, &dirs, |p| p.is_file())
}

pub fn find_in_dirs(
    exe: &str,
    dirs: &[PathBuf],
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    dirs.iter().map(|d| d.join(exe)).find(|p| exists(p))
}

fn extra_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    #[allow(deprecated)]
    let home = std::env::home_dir();
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let local = PathBuf::from(local);
            dirs.push(local.join("Microsoft").join("WinGet").join("Links"));
            dirs.push(local.join("Microsoft").join("DevTunnels"));
        }
    } else {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        if let Some(h) = &home {
            dirs.push(h.join("bin"));
            dirs.push(h.join(".local").join("bin"));
        }
    }
    dirs
}

fn cli(bin: &Path) -> Command {
    let mut cmd = Command::new(bin);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

struct CliOutput {
    ok: bool,
    text: String,
}

async fn run(bin: &Path, args: &[&str]) -> Result<CliOutput, String> {
    log::debug!("devtunnel {}", args.join(" "));
    let fut = cli(bin).args(args).output();
    let out = tokio::time::timeout(CLI_TIMEOUT, fut)
        .await
        .map_err(|_| err_failed(format!("`devtunnel {}` timed out", args[0])))?
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                ERR_NOT_INSTALLED.to_owned()
            } else {
                err_failed(e.to_string())
            }
        })?;
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok(CliOutput {
        ok: out.status.success(),
        text,
    })
}

fn fail(out: &CliOutput) -> String {
    if looks_like_auth_error(&out.text) {
        ERR_NOT_LOGGED_IN.to_owned()
    } else {
        err_failed(first_line(&out.text))
    }
}

fn first_line(text: &str) -> &str {
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("unknown error")
}

/// A running `devtunnel host` child. Killed on drop.
pub struct TunnelHost {
    child: Child,
    pub public_base: String,
}

impl TunnelHost {
    pub async fn stop(mut self) {
        if let Err(e) = self.child.kill().await {
            log::warn!("devtunnel host: kill failed: {e}");
        }
        log::info!("devtunnel host: stopped");
    }

    /// Resolves when the host process exits (e.g. network loss, CLI crash).
    pub async fn wait_exit(&mut self) -> String {
        match self.child.wait().await {
            Ok(status) => format!("host exited ({status})"),
            Err(e) => e.to_string(),
        }
    }
}

/// PIDs of `devtunnel host <tunnel_id>` processes in a `<pid> <command line>`
/// listing. Matches the tunnel id exactly so `excalidraw-desktop` never
/// matches `excalidraw-desktop-guest`.
pub fn stale_host_pids(listing: &str, tunnel_id: &str) -> Vec<u32> {
    listing
        .lines()
        .filter_map(|line| {
            let (pid, cmd) = line.trim().split_once(char::is_whitespace)?;
            let pid: u32 = pid.parse().ok()?;
            let args: Vec<&str> = cmd.split_whitespace().collect();
            let exe = args.first()?.trim_matches('"').to_ascii_lowercase();
            let name = exe.rsplit(['/', '\\']).next().unwrap_or(&exe);
            let is_devtunnel = name == "devtunnel" || name == "devtunnel.exe";
            let hosts_id = args.windows(2).any(|w| w[0] == "host" && w[1] == tunnel_id);
            (is_devtunnel && hosts_id && pid != std::process::id()).then_some(pid)
        })
        .collect()
}

/// Kill `devtunnel host` processes for this tunnel left behind by a crash
/// or SIGTERM (when `kill_on_drop` never ran). Best-effort.
async fn kill_stale_hosts(tunnel_id: &str) {
    #[cfg(unix)]
    let listing = Command::new("ps")
        .args(["-axo", "pid=,command="])
        .output()
        .await;
    #[cfg(windows)]
    let listing = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process -Filter \"Name='devtunnel.exe'\" | \
             ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }",
        ])
        .output()
        .await;
    let Ok(out) = listing else { return };
    for pid in stale_host_pids(&String::from_utf8_lossy(&out.stdout), tunnel_id) {
        log::warn!("devtunnel: killing stale host pid {pid} for {tunnel_id}");
        #[cfg(unix)]
        let killed = Command::new("kill").arg(pid.to_string()).status().await;
        #[cfg(windows)]
        let killed = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .status()
            .await;
        if let Err(e) = killed {
            log::warn!("devtunnel: kill {pid} failed: {e}");
        }
    }
}

/// Create/ensure the persistent tunnel, then start hosting it. Errors are
/// the exact `status.tunnel.error` strings from the contract.
pub async fn start_devtunnel(tunnel_id: &str, port: u16) -> Result<TunnelHost, String> {
    let bin = find_devtunnel().ok_or_else(|| ERR_NOT_INSTALLED.to_owned())?;
    log::info!("devtunnel: using {}", bin.display());

    let user = run(&bin, &["user", "show"]).await?;
    if !parse_logged_in(&user.text) {
        return Err(ERR_NOT_LOGGED_IN.to_owned());
    }

    let mut show = run(&bin, &["show", tunnel_id, "-j"]).await?;
    if !show.ok {
        if !is_not_found(&show.text) {
            return Err(fail(&show));
        }
        log::info!("devtunnel: creating tunnel {tunnel_id}");
        let created = run(&bin, &["create", tunnel_id]).await?;
        if !created.ok {
            return Err(fail(&created));
        }
        show = run(&bin, &["show", tunnel_id, "-j"]).await?;
        if !show.ok {
            return Err(fail(&show));
        }
    }
    let info = parse_show_json(&show.text).map_err(err_failed)?;

    // Hosting forwards every port on the tunnel; drop stale ones from
    // earlier sessions on a different port.
    for (p, _) in info.ports.iter().filter(|(p, _)| *p != port) {
        let ps = p.to_string();
        let out = run(&bin, &["port", "delete", tunnel_id, "-p", &ps]).await?;
        if !out.ok {
            log::warn!(
                "devtunnel: port delete {p} failed: {}",
                first_line(&out.text)
            );
        }
    }
    if !info.ports.iter().any(|(p, _)| *p == port) {
        let ps = port.to_string();
        let out = run(
            &bin,
            &["port", "create", tunnel_id, "-p", &ps, "--protocol", "http"],
        )
        .await?;
        if !out.ok && !out.text.to_ascii_lowercase().contains("conflict") {
            return Err(fail(&out));
        }
    }
    if !info.anonymous {
        let out = run(&bin, &["access", "create", tunnel_id, "--anonymous"]).await?;
        if !out.ok {
            return Err(fail(&out));
        }
    }

    kill_stale_hosts(tunnel_id).await;
    let mut child = cli(&bin)
        .args(["host", tunnel_id])
        .spawn()
        .map_err(|e| err_failed(e.to_string()))?;
    let stdout = child.stdout.take().ok_or_else(|| err_failed("no stdout"))?;
    let stderr = child.stderr.take();
    if let Some(stderr) = stderr {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::warn!("devtunnel host: {line}");
            }
        });
    }
    let mut lines = BufReader::new(stdout).lines();
    let wait_ready = async {
        let mut url: Option<String> = None;
        let mut tail = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            log::info!("devtunnel host: {line}");
            if url.is_none() {
                url = parse_host_url(&line, port);
            }
            if is_host_ready(&line) {
                return Ok(url);
            }
            if !line.trim().is_empty() {
                tail = line;
            }
        }
        Err(if looks_like_auth_error(&tail) {
            ERR_NOT_LOGGED_IN.to_owned()
        } else {
            err_failed(if tail.is_empty() {
                "host exited".to_owned()
            } else {
                tail
            })
        })
    };
    let url = match tokio::time::timeout(HOST_READY_TIMEOUT, wait_ready).await {
        Ok(Ok(url)) => url,
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err(err_failed("timed out waiting for `devtunnel host`")),
    };
    // Keep draining stdout so the child never blocks on a full pipe.
    tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            log::debug!("devtunnel host: {line}");
        }
    });
    let public_base = url
        .or_else(|| {
            info.ports
                .iter()
                .find(|(p, _)| *p == port)
                .and_then(|(_, u)| u.clone())
        })
        .map(|u| u.trim_end_matches('/').to_owned())
        .ok_or_else(|| err_failed("could not determine public URL"))?;
    log::info!("devtunnel: ready at {public_base}");
    Ok(TunnelHost { child, public_base })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_host_pids_matches_exact_tunnel_id() {
        let listing = "  101 /opt/homebrew/bin/devtunnel host excalidraw-desktop\n\
  102 /opt/homebrew/bin/devtunnel host excalidraw-desktop-guest\n\
  103 /usr/bin/vim notes about devtunnel host excalidraw-desktop\n\
  104 devtunnel user show\n\
  105 \"C:\\Tools\\devtunnel.exe\" host excalidraw-desktop\n\
garbage line\n";
        assert_eq!(
            stale_host_pids(listing, "excalidraw-desktop"),
            vec![101, 105]
        );
        assert_eq!(
            stale_host_pids(listing, "excalidraw-desktop-guest"),
            vec![102]
        );
    }

    const HOST_OUTPUT: &str = "Connection to host tunnel relay restored.\n\
Hosting port: 4780\n\
Connect via browser: https://drhbf9kg-4780.usw3.devtunnels.ms\n\
Inspect network activity: https://drhbf9kg-4780-inspect.usw3.devtunnels.ms\n\
\n\
Ready to accept connections for tunnel: exd-lanea-probe.usw3\n";

    const SHOW_JSON: &str = r#"{
  "tunnel": {
    "tunnelId": "exd-lanea-probe.usw3",
    "ports": [
      { "portNumber": 4780, "protocol": "http", "portUri": "https://drhbf9kg-4780.usw3.devtunnels.ms/" },
      { "portNumber": 4781, "protocol": "http" }
    ],
    "accessControl": [
      { "type": "Anonymous", "subjects": [], "scopes": ["connect"] }
    ]
  }
}"#;

    #[test]
    fn parses_host_output() {
        let urls: Vec<String> = HOST_OUTPUT
            .lines()
            .filter_map(|l| parse_host_url(l, 4780))
            .collect();
        assert_eq!(urls, vec!["https://drhbf9kg-4780.usw3.devtunnels.ms"]);
        assert!(HOST_OUTPUT.lines().any(is_host_ready));
        assert!(!is_host_ready("Hosting port: 4780"));
    }

    #[test]
    fn host_url_prefers_matching_port() {
        let line = "Connect via browser: https://abc-4781.usw3.devtunnels.ms, https://abc-4780.usw3.devtunnels.ms/";
        assert_eq!(
            parse_host_url(line, 4780).as_deref(),
            Some("https://abc-4780.usw3.devtunnels.ms")
        );
        assert_eq!(parse_host_url("Hosting port: 4780", 4780), None);
    }

    #[test]
    fn parses_show_json() {
        let info = parse_show_json(SHOW_JSON).unwrap();
        assert!(info.anonymous);
        assert_eq!(
            info.ports,
            vec![
                (
                    4780,
                    Some("https://drhbf9kg-4780.usw3.devtunnels.ms/".to_owned())
                ),
                (4781, None)
            ]
        );
        let bare = parse_show_json(r#"{"tunnel":{"tunnelId":"x"}}"#).unwrap();
        assert_eq!(bare, TunnelInfo::default());
        assert!(parse_show_json("Tunnel not found: x").is_err());
    }

    #[test]
    fn login_and_not_found_detection() {
        assert!(parse_logged_in(
            "Logged in as someone@example.com using Microsoft."
        ));
        assert!(!parse_logged_in("Not logged in."));
        assert!(is_not_found("Tunnel not found: excalidraw-desktop"));
        assert!(looks_like_auth_error("Error: Unauthorized"));
        assert!(!looks_like_auth_error(
            "Tunnel service error: Conflict with existing entity."
        ));
    }

    #[test]
    fn error_strings_match_contract() {
        assert_eq!(ERR_NOT_INSTALLED, "devtunnel_not_installed");
        assert_eq!(ERR_NOT_LOGGED_IN, "devtunnel_not_logged_in");
        assert_eq!(err_failed(" boom \n"), "devtunnel_failed: boom");
    }

    #[test]
    fn tunnel_ids() {
        assert_eq!(tunnel_id(None), "excalidraw-desktop");
        assert_eq!(tunnel_id(Some("")), "excalidraw-desktop");
        assert_eq!(tunnel_id(Some("Guest_2")), "excalidraw-desktop-guest-2");
    }

    #[test]
    fn manual_url_validation() {
        assert_eq!(
            validate_manual_url("  https://example.com/  ").unwrap(),
            "https://example.com"
        );
        assert_eq!(
            validate_manual_url("http://10.0.0.5:4780").unwrap(),
            "http://10.0.0.5:4780"
        );
        assert_eq!(
            validate_manual_url("https://proxy.example.com/excalidraw//").unwrap(),
            "https://proxy.example.com/excalidraw"
        );
        for bad in [
            "",
            "example.com",
            "ftp://example.com",
            "https://",
            "https:///path",
            "https://a b.com",
            "https://example.com/?q=1",
            "https://example.com/#room=x",
            "https://user:pw@example.com",
        ] {
            assert!(
                validate_manual_url(bad).is_err(),
                "{bad} should be rejected"
            );
        }
    }

    #[test]
    fn finds_binary_in_dirs() {
        let dirs = vec![PathBuf::from("/nope"), PathBuf::from("/opt/homebrew/bin")];
        let found = find_in_dirs("devtunnel", &dirs, |p| {
            p == Path::new("/opt/homebrew/bin/devtunnel")
        });
        assert_eq!(found, Some(PathBuf::from("/opt/homebrew/bin/devtunnel")));
        assert_eq!(find_in_dirs("devtunnel", &dirs, |_| false), None);
    }
}

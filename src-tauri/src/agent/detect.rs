//! Binary discovery, version + login probing (core lane). See docs/ai-integration.md
//! "Process hygiene".
//!
//! GUI apps on macOS inherit launchd's minimal PATH, so we capture the user's login-shell
//! environment (`$SHELL -ilc`, with a timeout), fall back to `launchctl getenv PATH`, and on
//! Windows merge the PowerShell profile / no-profile PATH. Well-known install dirs are searched
//! after PATH. Never runs a model turn: only `--version` and offline auth-status subcommands.
//!
//! Portions adapted from T3 Code (https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc., MIT License.
use super::events::EngineKind;
use super::process::run_capture;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::sync::OnceCell;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EngineStatus {
    Ready,
    NotFound,
    NotLoggedIn,
    UnsupportedVersion,
    /// Login can't be probed offline (Copilot); verified on first session.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub engine: EngineKind,
    pub status: EngineStatus,
    pub path: Option<PathBuf>,
    pub version: Option<String>,
    pub min_version: String,
    pub message: Option<String>,
}

/// Minimum supported engine versions. Conservative picks, re-verified in the AI-0 spikes:
/// - Copilot CLI: 1.0.0 — first GA line; `--acp` shipped in late 0.0.x previews (Jan 2026).
/// - Claude Code: 2.0.0 — stream-json I/O, `--append-system-prompt`, `--permission-prompt-tool`.
/// - Codex: 0.60.0 — `codex app-server` v2 protocol and `codex login status`.
pub const MIN_COPILOT_VERSION: &str = "1.0.0";
pub const MIN_CLAUDE_VERSION: &str = "2.0.0";
pub const MIN_CODEX_VERSION: &str = "0.60.0";

const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10);
const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(5);
/// One longer wait for the first shell that times out (slow profile while the machine boots).
const SLOW_LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(15);
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const LAUNCHCTL_TIMEOUT: Duration = Duration::from_secs(2);
const NPM_PREFIX_TIMEOUT: Duration = Duration::from_secs(5);

pub const ALL_ENGINES: [EngineKind; 3] =
    [EngineKind::Copilot, EngineKind::Claude, EngineKind::Codex];

pub fn min_version(engine: EngineKind) -> &'static str {
    match engine {
        EngineKind::Copilot => MIN_COPILOT_VERSION,
        EngineKind::Claude => MIN_CLAUDE_VERSION,
        EngineKind::Codex => MIN_CODEX_VERSION,
    }
}

pub fn binary_name(engine: EngineKind) -> &'static str {
    match engine {
        EngineKind::Copilot => "copilot",
        EngineKind::Claude => "claude",
        EngineKind::Codex => "codex",
    }
}

fn login_hint(engine: EngineKind) -> &'static str {
    match engine {
        EngineKind::Copilot => "Run `copilot` in a terminal and use /login.",
        EngineKind::Claude => "Run `claude auth login` in a terminal.",
        EngineKind::Codex => "Run `codex login` in a terminal.",
    }
}

// ---------------------------------------------------------------------------------------------
// Shell environment discovery
// ---------------------------------------------------------------------------------------------

/// Environment overlay for engine processes (always includes `PATH` when discovery worked).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ShellEnv {
    pub vars: Vec<(String, String)>,
}

impl ShellEnv {
    pub fn get(&self, name: &str) -> Option<&str> {
        self.vars
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    pub fn path(&self) -> Option<&str> {
        self.get("PATH")
    }

    fn set(&mut self, name: &str, value: String) {
        match self.vars.iter_mut().find(|(k, _)| k == name) {
            Some(slot) => slot.1 = value,
            None => self.vars.push((name.to_string(), value)),
        }
    }

    /// Env for spawning `binary`: its own directory is prepended to PATH so `#!/usr/bin/env node`
    /// shims installed next to their node (nvm, Volta, npm prefix) work.
    pub fn for_binary(&self, binary: &Path) -> Vec<(String, String)> {
        let mut env = self.clone();
        if let Some(dir) = binary.parent().filter(|d| !d.as_os_str().is_empty()) {
            let dir = dir.to_string_lossy().into_owned();
            let merged = merge_paths(&[Some(dir.as_str()), self.path()]);
            if let Some(merged) = merged {
                env.set("PATH", merged);
            }
        }
        env.vars
    }
}

static SHELL_ENV: OnceCell<ShellEnv> = OnceCell::const_new();

/// Discovered once per app run, then cached.
pub async fn shell_env() -> &'static ShellEnv {
    SHELL_ENV
        .get_or_init(|| async {
            let env = discover_shell_env().await;
            log::info!(
                "agent/detect: shell PATH has {} entries",
                env.path().map(|p| p.split(PATH_SEP).count()).unwrap_or(0)
            );
            env
        })
        .await
}

#[cfg(windows)]
const PATH_SEP: char = ';';
#[cfg(not(windows))]
const PATH_SEP: char = ':';

/// Variables captured from the login shell. PATH plus version-manager state (fnm/mise/pnpm)
/// and TLS settings node-based CLIs need.
#[cfg_attr(windows, allow(dead_code))]
const LOGIN_SHELL_ENV_NAMES: &[&str] = &[
    "PATH",
    "__MISE_DIFF",
    "FNM_DIR",
    "FNM_MULTISHELL_PATH",
    "PNPM_HOME",
    "HOMEBREW_PREFIX",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
];

pub async fn discover_shell_env() -> ShellEnv {
    let inherited: Vec<(String, String)> = std::env::vars().collect();
    #[cfg(windows)]
    {
        discover_windows(&inherited).await
    }
    #[cfg(not(windows))]
    {
        let shells = login_shell_candidates(
            std::env::var("SHELL").ok().as_deref(),
            user_login_shell().as_deref(),
        );
        discover_posix(&shells, &inherited, cfg!(target_os = "macos")).await
    }
}

#[cfg_attr(windows, allow(dead_code))]
fn login_shell_candidates(shell: Option<&str>, user_shell: Option<&str>) -> Vec<String> {
    let fallback = if cfg!(target_os = "macos") {
        Some("/bin/zsh")
    } else if cfg!(target_os = "linux") {
        Some("/bin/bash")
    } else {
        None
    };
    let mut out: Vec<String> = Vec::new();
    for c in [shell, user_shell, fallback].into_iter().flatten() {
        let c = c.trim();
        if !c.is_empty() && !out.iter().any(|s| s == c) {
            out.push(c.to_string());
        }
    }
    out
}

#[cfg(unix)]
fn user_login_shell() -> Option<String> {
    // SAFETY: getpwuid returns a pointer into static storage; we copy the string immediately.
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() || (*pw).pw_shell.is_null() {
            return None;
        }
        let s = std::ffi::CStr::from_ptr((*pw).pw_shell)
            .to_string_lossy()
            .trim()
            .to_string();
        (!s.is_empty()).then_some(s)
    }
}

#[cfg(not(unix))]
#[allow(dead_code)]
fn user_login_shell() -> Option<String> {
    None
}

fn start_marker(name: &str) -> String {
    format!("__EXCALIDRAW_ENV_{name}_START__")
}

fn end_marker(name: &str) -> String {
    format!("__EXCALIDRAW_ENV_{name}_END__")
}

fn valid_env_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

/// POSIX `-ilc` script printing each var between markers (profile noise is ignored).
#[cfg_attr(windows, allow(dead_code))]
fn posix_capture_command(shell: &str, names: &[&str]) -> String {
    let capture = names
        .iter()
        .filter(|n| valid_env_name(n))
        .map(|n| {
            format!(
                "printf '%s\\n' '{}'; printenv {n} || true; printf '%s\\n' '{}'",
                start_marker(n),
                end_marker(n)
            )
        })
        .collect::<Vec<_>>()
        .join("; ");
    let exe = Path::new(shell)
        .file_name()
        .map(|f| f.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    // A DEBUG trap that echoes each command would print the markers twice.
    if ["bash", "zsh", "sh", "ksh", "ksh93"].contains(&exe.as_str()) {
        format!("(trap - DEBUG) 2>/dev/null && trap - DEBUG; {capture}")
    } else {
        capture
    }
}

fn extract_env(output: &str, names: &[&str]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for name in names {
        let start = start_marker(name);
        let Some(s) = output.find(&start) else {
            continue;
        };
        let value_start = s + start.len();
        let Some(e) = output[value_start..].find(&end_marker(name)) else {
            continue;
        };
        let raw = &output[value_start..value_start + e];
        let value = raw
            .strip_prefix("\r\n")
            .or_else(|| raw.strip_prefix('\n'))
            .unwrap_or(raw);
        let value = value
            .strip_suffix("\r\n")
            .or_else(|| value.strip_suffix('\n'))
            .unwrap_or(value);
        if !value.is_empty() {
            out.push((name.to_string(), value.to_string()));
        }
    }
    out
}

/// Ordered, de-duplicated PATH merge (first occurrence wins).
fn merge_paths(values: &[Option<&str>]) -> Option<String> {
    let mut seen: Vec<String> = Vec::new();
    for value in values.iter().flatten() {
        for entry in value.split(PATH_SEP) {
            let entry = if cfg!(windows) { entry.trim() } else { entry };
            if entry.is_empty() {
                continue;
            }
            let dup = seen.iter().any(|s| {
                if cfg!(windows) {
                    s.eq_ignore_ascii_case(entry)
                } else {
                    s == entry
                }
            });
            if !dup {
                seen.push(entry.to_string());
            }
        }
    }
    (!seen.is_empty()).then(|| seen.join(&PATH_SEP.to_string()))
}

fn env_lookup<'a>(env: &'a [(String, String)], name: &str) -> Option<&'a str> {
    env.iter()
        .find(|(k, _)| {
            if cfg!(windows) {
                k.eq_ignore_ascii_case(name)
            } else {
                k == name
            }
        })
        .map(|(_, v)| v.as_str())
        .filter(|v| !v.trim().is_empty())
}

#[cfg_attr(windows, allow(dead_code))]
async fn discover_posix(
    shells: &[String],
    inherited: &[(String, String)],
    use_launchctl: bool,
) -> ShellEnv {
    let mut captured: Vec<(String, String)> = Vec::new();
    let mut waited_slow = false;
    for shell in shells {
        let script = posix_capture_command(shell, LOGIN_SHELL_ENV_NAMES);
        let mut res = run_capture(
            Path::new(shell),
            &["-ilc", &script],
            inherited,
            LOGIN_SHELL_TIMEOUT,
        )
        .await;
        if matches!(&res, Err(e) if e.kind() == std::io::ErrorKind::TimedOut) && !waited_slow {
            waited_slow = true;
            log::warn!("agent/detect: login shell {shell} timed out; retrying once");
            res = run_capture(
                Path::new(shell),
                &["-ilc", &script],
                inherited,
                SLOW_LOGIN_SHELL_TIMEOUT,
            )
            .await;
        }
        match res {
            Ok(out) => {
                let env = extract_env(&out.stdout, LOGIN_SHELL_ENV_NAMES);
                if env.iter().any(|(k, _)| k == "PATH") {
                    captured = env;
                    break;
                }
            }
            Err(e) => log::warn!("agent/detect: login shell {shell} probe failed: {e}"),
        }
    }

    let shell_path = env_lookup(&captured, "PATH").map(str::to_string);
    let launchctl_path = if shell_path.is_none() && use_launchctl {
        read_launchctl_path(inherited).await
    } else {
        None
    };
    let mut env = ShellEnv::default();
    if let Some(path) = merge_paths(&[
        shell_path.as_deref().or(launchctl_path.as_deref()),
        env_lookup(inherited, "PATH"),
    ]) {
        env.set("PATH", path);
    }
    for (k, v) in captured {
        if k == "PATH" {
            continue;
        }
        // mise's PATH delta must describe the PATH we hand over; others only fill gaps.
        if k == "__MISE_DIFF" || env_lookup(inherited, &k).is_none() {
            env.set(&k, v);
        }
    }
    env
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
async fn read_launchctl_path(inherited: &[(String, String)]) -> Option<String> {
    run_capture(
        Path::new("/bin/launchctl"),
        &["getenv", "PATH"],
        inherited,
        LAUNCHCTL_TIMEOUT,
    )
    .await
    .ok()
    .filter(|o| o.code == Some(0))
    .map(|o| o.stdout.trim().to_string())
    .filter(|s| !s.is_empty())
}

#[cfg_attr(not(windows), allow(dead_code))]
fn windows_capture_command(names: &[&str]) -> String {
    let mut parts = vec!["$ErrorActionPreference = 'Stop'".to_string()];
    for name in names.iter().filter(|n| valid_env_name(n)) {
        parts.push(format!("Write-Output '{}'", start_marker(name)));
        if *name == "PATH" {
            // Process first so profile prepends win; User and Machine add dirs missing from it.
            parts.push(
                "$value = (@([Environment]::GetEnvironmentVariable('PATH','Process'),\
                 [Environment]::GetEnvironmentVariable('PATH','Machine'),\
                 [Environment]::GetEnvironmentVariable('PATH','User')) | Where-Object { $_ }) -join ';'"
                    .to_string(),
            );
        } else {
            parts.push(format!(
                "$value = [Environment]::GetEnvironmentVariable('{name}')"
            ));
        }
        parts.push(
            "if ($null -ne $value -and $value.Length -gt 0) { Write-Output $value }".to_string(),
        );
        parts.push(format!("Write-Output '{}'", end_marker(name)));
    }
    parts.join("; ")
}

#[cfg(windows)]
async fn read_windows_env(
    names: &[&str],
    load_profile: bool,
    inherited: &[(String, String)],
) -> Vec<(String, String)> {
    let script = windows_capture_command(names);
    let mut args = vec!["-NoLogo"];
    if !load_profile {
        args.push("-NoProfile");
    }
    args.extend(["-NonInteractive", "-Command", &script]);
    for shell in ["pwsh.exe", "powershell.exe"] {
        match run_capture(Path::new(shell), &args, inherited, LOGIN_SHELL_TIMEOUT).await {
            Ok(out) => {
                let env = extract_env(&out.stdout, names);
                if !env.is_empty() {
                    return env;
                }
            }
            Err(e) => log::debug!("agent/detect: {shell} env probe failed: {e}"),
        }
    }
    Vec::new()
}

#[cfg(windows)]
async fn discover_windows(inherited: &[(String, String)]) -> ShellEnv {
    let profile_names = ["PATH", "FNM_DIR", "FNM_MULTISHELL_PATH"];
    let (no_profile, profile) = tokio::join!(
        read_windows_env(&["PATH"], false, inherited),
        read_windows_env(&profile_names, true, inherited)
    );
    let known = candidate_dirs(inherited)
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(";");
    let mut env = ShellEnv::default();
    if let Some(path) = merge_paths(&[
        env_lookup(&profile, "PATH"),
        Some(known.as_str()),
        env_lookup(&no_profile, "PATH"),
        env_lookup(inherited, "PATH"),
    ]) {
        env.set("PATH", path);
    }
    for name in ["FNM_DIR", "FNM_MULTISHELL_PATH"] {
        if env_lookup(inherited, name).is_none() {
            if let Some(v) = env_lookup(&profile, name) {
                env.set(name, v.to_string());
            }
        }
    }
    env
}

/// Well-known per-user/global install dirs searched after PATH.
pub fn candidate_dirs(env: &[(String, String)]) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if cfg!(windows) {
        if let Some(appdata) = env_lookup(env, "APPDATA") {
            dirs.push(Path::new(appdata).join("npm"));
        }
        if let Some(local) = env_lookup(env, "LOCALAPPDATA") {
            let local = Path::new(local);
            dirs.push(local.join("Microsoft").join("WinGet").join("Links"));
            dirs.push(local.join("Programs").join("nodejs"));
            dirs.push(local.join("Volta").join("bin"));
            dirs.push(local.join("pnpm"));
        }
        if let Some(profile) = env_lookup(env, "USERPROFILE") {
            let profile = Path::new(profile);
            dirs.push(profile.join(".local").join("bin"));
            dirs.push(profile.join(".bun").join("bin"));
            dirs.push(profile.join("scoop").join("shims"));
        }
        if let Some(pf) = env_lookup(env, "ProgramFiles") {
            dirs.push(Path::new(pf).join("nodejs"));
        }
    } else {
        if let Some(home) = env_lookup(env, "HOME") {
            let home = Path::new(home);
            dirs.push(home.join(".local/bin"));
            dirs.push(home.join(".claude/local"));
            dirs.push(home.join(".npm-global/bin"));
            dirs.push(home.join(".bun/bin"));
            dirs.push(home.join(".volta/bin"));
            dirs.push(home.join(".local/share/pnpm"));
            dirs.push(home.join("Library/pnpm"));
            // nvm installs: newest version first.
            if let Ok(rd) = std::fs::read_dir(home.join(".nvm/versions/node")) {
                let mut versions: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
                versions.sort_by(|a, b| {
                    let v = |p: &PathBuf| {
                        p.file_name()
                            .and_then(|f| parse_version(&f.to_string_lossy()))
                    };
                    v(b).cmp(&v(a))
                });
                dirs.extend(versions.into_iter().map(|p| p.join("bin")));
            }
        }
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }
    dirs
}

// ---------------------------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------------------------

/// Inputs for probing; production uses [`ProbeEnv::system`], tests build one by hand.
#[derive(Debug, Clone, Default)]
pub struct ProbeEnv {
    /// Environment for probe processes and engine spawns (PATH etc.).
    pub shell: ShellEnv,
    /// Searched after PATH.
    pub extra_dirs: Vec<PathBuf>,
    /// Try `npm config get prefix` when nothing else matched.
    pub npm_fallback: bool,
}

impl ProbeEnv {
    pub async fn system() -> Self {
        let shell = shell_env().await.clone();
        let mut env: Vec<(String, String)> = std::env::vars().collect();
        env.extend(shell.vars.iter().cloned());
        Self {
            extra_dirs: candidate_dirs(&env),
            shell,
            npm_fallback: true,
        }
    }

    fn search_path(&self) -> String {
        self.shell
            .path()
            .map(str::to_string)
            .or_else(|| std::env::var("PATH").ok())
            .unwrap_or_default()
    }
}

fn path_exts() -> Vec<String> {
    if cfg!(windows) {
        let raw = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        raw.split(';')
            .map(|e| e.trim().to_ascii_lowercase())
            .filter(|e| matches!(e.as_str(), ".com" | ".exe" | ".bat" | ".cmd"))
            .collect()
    } else {
        Vec::new()
    }
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn find_in_dir(dir: &Path, name: &str) -> Option<PathBuf> {
    let exts = path_exts();
    if exts.is_empty() {
        let p = dir.join(name);
        return is_executable(&p).then_some(p);
    }
    exts.iter()
        .map(|ext| dir.join(format!("{name}{ext}")))
        .find(|p| is_executable(p))
}

/// `which`: first match on `search_path`, then `extra_dirs`.
pub fn which(name: &str, search_path: &str, extra_dirs: &[PathBuf]) -> Option<PathBuf> {
    search_path
        .split(PATH_SEP)
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .chain(extra_dirs.iter().cloned())
        .find_map(|dir| find_in_dir(&dir, name))
}

async fn npm_global_bin(probe: &ProbeEnv) -> Option<PathBuf> {
    let npm = which("npm", &probe.search_path(), &probe.extra_dirs)?;
    let out = run_capture(
        &npm,
        &["config", "get", "prefix"],
        &probe.shell.for_binary(&npm),
        NPM_PREFIX_TIMEOUT,
    )
    .await
    .ok()?;
    let prefix = out.stdout.trim();
    if out.code != Some(0) || prefix.is_empty() {
        return None;
    }
    Some(if cfg!(windows) {
        PathBuf::from(prefix)
    } else {
        Path::new(prefix).join("bin")
    })
}

/// Resolve an engine binary: explicit override, else PATH, else candidate dirs, else npm prefix.
pub async fn resolve_binary(
    engine: EngineKind,
    path_override: Option<&Path>,
    probe: &ProbeEnv,
) -> Option<PathBuf> {
    if let Some(p) = path_override {
        return is_executable(p).then(|| p.to_path_buf());
    }
    let name = binary_name(engine);
    if let Some(p) = which(name, &probe.search_path(), &probe.extra_dirs) {
        return Some(p);
    }
    if probe.npm_fallback {
        if let Some(bin) = npm_global_bin(probe).await {
            return find_in_dir(&bin, name);
        }
    }
    None
}

// ---------------------------------------------------------------------------------------------
// Version + login probing
// ---------------------------------------------------------------------------------------------

/// First `MAJOR.MINOR.PATCH` in `s` (pre-release/build suffixes ignored).
pub fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let boundary = |j: usize| j == 0 || !bytes[j - 1].is_ascii_alphanumeric();
        let starts = i == 0
            || !bytes[i - 1].is_ascii_alphanumeric()
            || (bytes[i - 1] == b'v' && boundary(i - 1));
        if bytes[i].is_ascii_digit() && starts {
            let rest = &s[i..];
            let end = rest
                .find(|c: char| !(c.is_ascii_digit() || c == '.'))
                .unwrap_or(rest.len());
            let nums: Vec<&str> = rest[..end].split('.').collect();
            if nums.len() >= 3 {
                if let (Ok(a), Ok(b), Ok(c)) = (nums[0].parse(), nums[1].parse(), nums[2].parse()) {
                    return Some((a, b, c));
                }
            }
            i += end.max(1);
        } else {
            i += 1;
        }
    }
    None
}

fn version_string(v: (u64, u64, u64)) -> String {
    format!("{}.{}.{}", v.0, v.1, v.2)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Login {
    LoggedIn,
    LoggedOut,
    Unknown,
}

fn classify_claude_auth(code: Option<i32>, stdout: &str, stderr: &str) -> Login {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
        if let Some(b) = v.get("loggedIn").and_then(|b| b.as_bool()) {
            return if b { Login::LoggedIn } else { Login::LoggedOut };
        }
    }
    classify_text_auth(code, stdout, stderr, false)
}

fn classify_text_auth(code: Option<i32>, stdout: &str, stderr: &str, ok_means_in: bool) -> Login {
    let text = format!("{stdout}\n{stderr}").to_ascii_lowercase();
    if text.contains("not logged in") || text.contains("not authenticated") {
        Login::LoggedOut
    } else if code == Some(0) && (ok_means_in || text.contains("logged in")) {
        Login::LoggedIn
    } else {
        Login::Unknown
    }
}

async fn probe_login(engine: EngineKind, binary: &Path, env: &[(String, String)]) -> Login {
    let (args, claude): (&[&str], bool) = match engine {
        // Copilot has no offline status command; first session verifies.
        EngineKind::Copilot => return Login::Unknown,
        EngineKind::Claude => (&["auth", "status"], true),
        EngineKind::Codex => (&["login", "status"], false),
    };
    match run_capture(binary, args, env, LOGIN_TIMEOUT).await {
        Ok(o) if claude => classify_claude_auth(o.code, &o.stdout, &o.stderr),
        Ok(o) => classify_text_auth(o.code, &o.stdout, &o.stderr, true),
        Err(e) => {
            log::warn!("agent/detect: {engine:?} login probe failed: {e}");
            Login::Unknown
        }
    }
}

/// Probe one engine. Never runs a model turn.
pub async fn detect_engine(
    engine: EngineKind,
    path_override: Option<&Path>,
    probe: &ProbeEnv,
) -> EngineInfo {
    let min = min_version(engine);
    let mut info = EngineInfo {
        engine,
        status: EngineStatus::NotFound,
        path: None,
        version: None,
        min_version: min.to_string(),
        message: None,
    };
    let Some(binary) = resolve_binary(engine, path_override, probe).await else {
        info.message = Some(match path_override {
            Some(p) => format!("{} is not an executable file.", p.display()),
            None => format!("`{}` was not found on PATH.", binary_name(engine)),
        });
        return info;
    };
    info.path = Some(binary.clone());
    let env = probe.shell.for_binary(&binary);

    let version = match run_capture(&binary, &["--version"], &env, VERSION_TIMEOUT).await {
        Ok(o) => parse_version(&o.stdout).or_else(|| parse_version(&o.stderr)),
        Err(e) => {
            info.status = EngineStatus::Unknown;
            info.message = Some(format!(
                "Couldn't run `{} --version`: {e}",
                binary.display()
            ));
            return info;
        }
    };
    let Some(version) = version else {
        info.status = EngineStatus::Unknown;
        info.message = Some("Couldn't read the engine version.".into());
        return info;
    };
    info.version = Some(version_string(version));
    if parse_version(min).is_some_and(|m| version < m) {
        info.status = EngineStatus::UnsupportedVersion;
        info.message = Some(format!(
            "Version {} is older than the minimum supported {min}. Please update.",
            version_string(version)
        ));
        return info;
    }

    match probe_login(engine, &binary, &env).await {
        Login::LoggedIn => info.status = EngineStatus::Ready,
        Login::LoggedOut => {
            info.status = EngineStatus::NotLoggedIn;
            info.message = Some(format!("Not signed in. {}", login_hint(engine)));
        }
        Login::Unknown => {
            info.status = EngineStatus::Unknown;
            info.message = Some("Sign-in is verified when the first session starts.".into());
        }
    }
    info
}

/// Probe all engines concurrently. `overrides` maps an engine to a user-chosen binary path.
pub async fn detect_all(
    overrides: &[(EngineKind, Option<PathBuf>)],
    probe: &ProbeEnv,
) -> Vec<EngineInfo> {
    let futs = ALL_ENGINES.iter().map(|&engine| {
        let ov = overrides
            .iter()
            .find(|(e, _)| *e == engine)
            .and_then(|(_, p)| p.clone());
        async move { detect_engine(engine, ov.as_deref(), probe).await }
    });
    futures_util::future::join_all(futs).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_engine_version_strings() {
        assert_eq!(parse_version("2.1.329 (Claude Code)"), Some((2, 1, 329)));
        assert_eq!(parse_version("codex-cli 0.63.0"), Some((0, 63, 0)));
        assert_eq!(parse_version("1.0.65\nCommit: abc123"), Some((1, 0, 65)));
        assert_eq!(parse_version("v1.2.3-beta.4"), Some((1, 2, 3)));
        assert_eq!(parse_version("build x2.3 then 4.5.6"), Some((4, 5, 6)));
        assert_eq!(parse_version("no version"), None);
        assert!(parse_version(MIN_CODEX_VERSION).is_some());
    }

    #[test]
    fn extracts_marked_env_values_amid_profile_noise() {
        let out = format!(
            "Welcome!\n{}\n/a:/b\n{}\nnoise\n{}\n{}\n",
            start_marker("PATH"),
            end_marker("PATH"),
            start_marker("FNM_DIR"),
            end_marker("FNM_DIR")
        );
        assert_eq!(
            extract_env(&out, &["PATH", "FNM_DIR", "MISSING"]),
            vec![("PATH".to_string(), "/a:/b".to_string())]
        );
    }

    #[test]
    fn capture_command_rejects_bad_names_and_clears_debug_trap() {
        let cmd = posix_capture_command("/bin/zsh", &["PATH", "BAD;rm"]);
        assert!(cmd.starts_with("(trap - DEBUG)"));
        assert!(cmd.contains("printenv PATH"));
        assert!(!cmd.contains("rm"));
        assert!(!posix_capture_command("/usr/bin/fish", &["PATH"]).contains("trap"));
        assert!(windows_capture_command(&["PATH"]).contains("'Machine'"));
    }

    #[cfg(unix)]
    #[test]
    fn merges_paths_in_order_without_duplicates() {
        assert_eq!(
            merge_paths(&[Some("/a:/b"), None, Some("/b::/c")]).as_deref(),
            Some("/a:/b:/c")
        );
        assert_eq!(merge_paths(&[None, Some("")]), None);
    }

    #[test]
    fn classifies_auth_status_output() {
        assert_eq!(
            classify_claude_auth(Some(0), r#"{"loggedIn":true}"#, ""),
            Login::LoggedIn
        );
        assert_eq!(
            classify_claude_auth(Some(1), r#"{"loggedIn":false}"#, ""),
            Login::LoggedOut
        );
        assert_eq!(
            classify_claude_auth(Some(1), "", "error: unknown command 'auth'"),
            Login::Unknown
        );
        assert_eq!(
            classify_text_auth(Some(0), "", "Logged in using ChatGPT", true),
            Login::LoggedIn
        );
        assert_eq!(
            classify_text_auth(Some(1), "Not logged in", "", true),
            Login::LoggedOut
        );
    }

    #[test]
    fn shell_candidates_dedupe_and_fall_back() {
        let c = login_shell_candidates(Some("/bin/zsh "), Some("/bin/zsh"));
        assert_eq!(c[0], "/bin/zsh");
        assert_eq!(c.iter().filter(|s| *s == "/bin/zsh").count(), 1);
    }

    #[cfg(unix)]
    mod unix {
        use super::super::*;
        use std::os::unix::fs::PermissionsExt;

        fn write_exe(dir: &Path, name: &str, body: &str) -> PathBuf {
            let p = dir.join(name);
            std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            p
        }

        fn probe(dir: &Path) -> ProbeEnv {
            ProbeEnv {
                shell: ShellEnv {
                    vars: vec![("PATH".into(), format!("{}:/usr/bin:/bin", dir.display()))],
                },
                extra_dirs: vec![],
                npm_fallback: false,
            }
        }

        #[tokio::test]
        async fn detects_ready_logged_out_old_and_missing_engines() {
            let dir = tempfile::tempdir().unwrap();
            write_exe(
                dir.path(),
                "claude",
                r#"case "$1" in --version) echo "2.1.329 (Claude Code)";; auth) echo '{"loggedIn":false}'; exit 1;; esac"#,
            );
            write_exe(
                dir.path(),
                "codex",
                r#"case "$1" in --version) echo "codex-cli 0.70.1";; login) echo "Logged in using ChatGPT" >&2;; esac"#,
            );
            let p = probe(dir.path());
            let all = detect_all(&[], &p).await;
            let get = |e| all.iter().find(|i| i.engine == e).unwrap();

            let claude = get(EngineKind::Claude);
            assert_eq!(claude.status, EngineStatus::NotLoggedIn);
            assert_eq!(claude.version.as_deref(), Some("2.1.329"));
            assert_eq!(
                claude.path.as_deref(),
                Some(dir.path().join("claude").as_path())
            );

            let codex = get(EngineKind::Codex);
            assert_eq!(codex.status, EngineStatus::Ready, "{codex:?}");

            let copilot = get(EngineKind::Copilot);
            assert_eq!(copilot.status, EngineStatus::NotFound);
            assert_eq!(copilot.min_version, MIN_COPILOT_VERSION);

            // Old version via override path.
            let old = write_exe(dir.path(), "old-copilot", r#"echo "0.0.300""#);
            let info = detect_engine(EngineKind::Copilot, Some(&old), &p).await;
            assert_eq!(info.status, EngineStatus::UnsupportedVersion);
            // Current version: Copilot login can't be probed offline.
            let cur = write_exe(dir.path(), "new-copilot", r#"echo "1.0.65""#);
            let info = detect_engine(EngineKind::Copilot, Some(&cur), &p).await;
            assert_eq!(info.status, EngineStatus::Unknown);

            let missing =
                detect_engine(EngineKind::Claude, Some(&dir.path().join("nope")), &p).await;
            assert_eq!(missing.status, EngineStatus::NotFound);
        }

        #[tokio::test]
        async fn finds_binaries_in_extra_dirs_and_prepends_their_dir() {
            let dir = tempfile::tempdir().unwrap();
            let bin = write_exe(dir.path(), "codex", "exit 0");
            let mut p = probe(Path::new("/nonexistent"));
            p.extra_dirs = vec![dir.path().to_path_buf()];
            let found = resolve_binary(EngineKind::Codex, None, &p).await.unwrap();
            assert_eq!(found, bin);
            let env = p.shell.for_binary(&found);
            let path = &env.iter().find(|(k, _)| k == "PATH").unwrap().1;
            assert!(path.starts_with(&dir.path().display().to_string()));
            // Non-executable files are skipped.
            std::fs::write(dir.path().join("claude"), "x").unwrap();
            assert!(resolve_binary(EngineKind::Claude, None, &p).await.is_none());
        }

        #[tokio::test]
        async fn discovers_path_from_login_shell() {
            let dir = tempfile::tempdir().unwrap();
            // Fake login shell: noisy profile, then runs the -ilc script with an extended PATH.
            let shell = write_exe(
                dir.path(),
                "fakesh",
                r#"echo "profile noise"; PATH="/from/profile:$PATH" __MISE_DIFF=abc exec /bin/sh -c "$2""#,
            );
            let inherited = vec![("PATH".to_string(), "/usr/bin:/bin".to_string())];
            let env = discover_posix(
                &["/nonexistent/shell".into(), shell.display().to_string()],
                &inherited,
                false,
            )
            .await;
            assert_eq!(env.path(), Some("/from/profile:/usr/bin:/bin"));
            assert_eq!(env.get("__MISE_DIFF"), Some("abc"));
        }

        #[tokio::test]
        async fn falls_back_to_inherited_path_when_no_shell_answers() {
            let inherited = vec![("PATH".to_string(), "/x:/y".to_string())];
            let env = discover_posix(&["/nonexistent".into()], &inherited, false).await;
            assert_eq!(env.path(), Some("/x:/y"));
        }
    }
}

#[cfg(test)]
mod live {
    #[tokio::test]
    #[ignore = "probes engines installed on this machine"]
    async fn live_detect() {
        let probe = super::ProbeEnv::system().await;
        for i in super::detect_all(&[], &probe).await {
            eprintln!("{i:?}");
        }
    }
}

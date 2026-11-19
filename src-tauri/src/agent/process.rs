//! Engine process lifecycle (core lane): spawn a [`LaunchSpec`] with piped stdio, read
//! stdout/stderr as lines, write NDJSON to stdin, and tear down the whole process tree.
//!
//! - POSIX: every engine gets its own process group (`setpgid(0, 0)`), torn down with
//!   `killpg` (SIGTERM, then SIGKILL after a grace period).
//! - Windows: `CREATE_NO_WINDOW` plus a Job Object with `KILL_ON_JOB_CLOSE`. npm `.cmd`
//!   shims are resolved to `node <script>` when possible; otherwise they run through
//!   `cmd /d /s /c` with every argument quoted and caret-escaped (no shell injection).
//!
//! Portions adapted from T3 Code (https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc., MIT License.
use super::adapter::LaunchSpec;
use std::io;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;

/// Grace between a polite terminate (SIGTERM) and a hard kill.
pub const TERMINATE_GRACE: Duration = Duration::from_millis(1500);

/// A spawned engine. The caller splits the pipes out and owns `child` for `wait()`.
pub struct EngineProcess {
    pub child: Child,
    pub stdin: Option<ChildStdin>,
    pub stdout: Option<ChildStdout>,
    pub stderr: Option<ChildStderr>,
    pub tree: ProcessTree,
}

/// Cloneable handle that can signal the whole process tree, independently of `Child`.
#[derive(Clone, Debug)]
pub struct ProcessTree {
    #[cfg_attr(not(unix), allow(dead_code))]
    pid: Option<u32>,
    #[cfg(windows)]
    job: Option<std::sync::Arc<win::Job>>,
}

impl ProcessTree {
    /// Polite stop: SIGTERM to the group (POSIX). Windows has no equivalent, so it kills.
    pub fn terminate(&self) {
        #[cfg(unix)]
        self.signal(libc::SIGTERM);
        #[cfg(windows)]
        self.kill();
    }

    /// Hard kill of every process in the tree.
    pub fn kill(&self) {
        #[cfg(unix)]
        self.signal(libc::SIGKILL);
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
        }
    }

    #[cfg(unix)]
    fn signal(&self, sig: libc::c_int) {
        if let Some(pid) = self.pid.and_then(|p| libc::pid_t::try_from(p).ok()) {
            if pid > 0 {
                // SAFETY: plain syscall; the group id is the leader pid (setpgid(0,0) at spawn).
                unsafe {
                    libc::killpg(pid, sig);
                }
            }
        }
    }
}

/// Spawn `spec` with piped stdio. `base_env` (e.g. the discovered login-shell PATH) is applied
/// first, then `spec.env_set`, then `spec.env_remove`.
pub fn spawn(spec: &LaunchSpec, base_env: &[(String, String)]) -> io::Result<EngineProcess> {
    let mut cmd = build_command(&spec.program, &spec.args, base_env)?;
    apply_env(&mut cmd, spec, base_env);
    if !spec.cwd.as_os_str().is_empty() {
        cmd.current_dir(&spec.cwd);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    spawn_in_tree(cmd)
}

fn apply_env(cmd: &mut Command, spec: &LaunchSpec, base_env: &[(String, String)]) {
    for (k, v) in base_env.iter().chain(spec.env_set.iter()) {
        cmd.env(k, v);
    }
    for k in &spec.env_remove {
        cmd.env_remove(k);
    }
}

fn spawn_in_tree(mut cmd: Command) -> io::Result<EngineProcess> {
    cmd.kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    cmd.creation_flags(win::CREATE_NO_WINDOW);

    let mut child = cmd.spawn()?;
    let pid = child.id();
    #[cfg(windows)]
    let job = win::Job::create().and_then(|job| {
        let handle = child.raw_handle()?;
        job.assign(handle).then(|| std::sync::Arc::new(job))
    });
    #[cfg(windows)]
    if job.is_none() {
        log::warn!("agent/process: job object unavailable; tree teardown limited to pid {pid:?}");
    }
    Ok(EngineProcess {
        stdin: child.stdin.take(),
        stdout: child.stdout.take(),
        stderr: child.stderr.take(),
        child,
        tree: ProcessTree {
            pid,
            #[cfg(windows)]
            job,
        },
    })
}

/// Wait for exit up to `grace`; then terminate the group, wait [`TERMINATE_GRACE`], then kill.
/// Always finishes by killing the tree so grandchildren (e.g. MCP shims) never leak.
pub async fn shutdown(child: &mut Child, tree: &ProcessTree, grace: Duration) -> Option<i32> {
    if let Ok(Ok(status)) = tokio::time::timeout(grace, child.wait()).await {
        tree.kill();
        return status.code();
    }
    tree.terminate();
    if let Ok(Ok(status)) = tokio::time::timeout(TERMINATE_GRACE, child.wait()).await {
        tree.kill();
        return status.code();
    }
    tree.kill();
    let _ = child.start_kill();
    child.wait().await.ok().and_then(|s| s.code())
}

/// Read `reader` as lines (LF or CRLF, lossy UTF-8) on a background task.
/// The receiver yields `None` at EOF.
pub fn line_channel<R>(reader: R) -> mpsc::UnboundedReceiver<String>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut reader = BufReader::new(reader);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    while matches!(buf.last(), Some(b'\n' | b'\r')) {
                        buf.pop();
                    }
                    if tx.send(String::from_utf8_lossy(&buf).into_owned()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    rx
}

/// Write one NDJSON line (newline appended) and flush.
pub async fn write_line(stdin: &mut ChildStdin, line: &str) -> io::Result<()> {
    let mut bytes = Vec::with_capacity(line.len() + 1);
    bytes.extend_from_slice(line.as_bytes());
    bytes.push(b'\n');
    stdin.write_all(&bytes).await?;
    stdin.flush().await
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureOutput {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Run a short-lived command (e.g. `--version`) with stdin closed. Returns `TimedOut` and kills
/// the tree if it doesn't exit within `timeout`.
pub async fn run_capture(
    program: &Path,
    args: &[&str],
    base_env: &[(String, String)],
    timeout: Duration,
) -> io::Result<CaptureOutput> {
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let mut cmd = build_command(program, &args, base_env)?;
    for (k, v) in base_env {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut proc = spawn_in_tree(cmd)?;
    let mut out = proc.stdout.take();
    let mut err = proc.stderr.take();
    let read_all = async {
        use tokio::io::AsyncReadExt;
        let mut so = Vec::new();
        let mut se = Vec::new();
        let a = async {
            if let Some(o) = out.as_mut() {
                let _ = o.read_to_end(&mut so).await;
            }
        };
        let b = async {
            if let Some(e) = err.as_mut() {
                let _ = e.read_to_end(&mut se).await;
            }
        };
        tokio::join!(a, b);
        let status = proc.child.wait().await?;
        io::Result::Ok(CaptureOutput {
            code: status.code(),
            stdout: String::from_utf8_lossy(&so).into_owned(),
            stderr: String::from_utf8_lossy(&se).into_owned(),
        })
    };
    match tokio::time::timeout(timeout, read_all).await {
        Ok(res) => {
            proc.tree.kill();
            res
        }
        Err(_) => {
            proc.tree.kill();
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("{} timed out after {timeout:?}", program.display()),
            ))
        }
    }
}

#[cfg(not(windows))]
fn build_command(
    program: &Path,
    args: &[String],
    _base_env: &[(String, String)],
) -> io::Result<Command> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    Ok(cmd)
}

#[cfg(windows)]
fn build_command(
    program: &Path,
    args: &[String],
    base_env: &[(String, String)],
) -> io::Result<Command> {
    if !is_batch_file(program) {
        let mut cmd = Command::new(program);
        cmd.args(args);
        return Ok(cmd);
    }
    let path_env = base_env
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
        .map(|(_, v)| v.clone())
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    if let Some((exe, script)) = resolve_npm_cmd_shim(program, &path_env) {
        let mut cmd = Command::new(exe);
        if let Some(script) = script {
            cmd.arg(script);
        }
        cmd.args(args);
        return Ok(cmd);
    }
    let line = cmd_shell_command_line(program, args)?;
    let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
    let mut cmd = Command::new(comspec);
    {
        use std::os::windows::process::CommandExt;
        cmd.as_std_mut().raw_arg(format!("/d /s /c \"{line}\""));
    }
    Ok(cmd)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn is_batch_file(program: &Path) -> bool {
    program
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
}

/// Build the inner `cmd /s /c "…"` line. Each token is quoted, then every cmd metacharacter
/// (including the quotes) is caret-escaped so cmd treats it literally, and `CommandLineToArgvW`
/// in the target still sees the quoted argument. CR/LF can't be carried through cmd at all.
#[cfg_attr(not(windows), allow(dead_code))]
fn cmd_shell_command_line(program: &Path, args: &[String]) -> io::Result<String> {
    let program = program.to_string_lossy();
    let mut parts = Vec::with_capacity(args.len() + 1);
    for a in std::iter::once(program.as_ref()).chain(args.iter().map(String::as_str)) {
        if a.contains(['\r', '\n', '\0']) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "argument contains a newline and can't be passed through a .cmd shim",
            ));
        }
        parts.push(escape_windows_shell_arg(a));
    }
    Ok(parts.join(" "))
}

#[cfg_attr(not(windows), allow(dead_code))]
fn escape_windows_shell_arg(arg: &str) -> String {
    // CommandLineToArgvW quoting: double backslashes that precede a quote or the closing quote.
    let mut quoted = String::with_capacity(arg.len() + 2);
    quoted.push('"');
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                quoted.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.extend(std::iter::repeat_n('\\', backslashes));
                quoted.push(c);
                backslashes = 0;
            }
        }
    }
    quoted.extend(std::iter::repeat_n('\\', backslashes * 2));
    quoted.push('"');
    let mut escaped = String::with_capacity(quoted.len() * 2);
    for c in quoted.chars() {
        if "()][%!^\"`<>&|;, *?".contains(c) {
            escaped.push('^');
        }
        escaped.push(c);
    }
    escaped
}

/// npm `cmd-shim` files end with `"%_prog%"  "%dp0%\node_modules\pkg\bin.js" %*`. Resolve that to
/// `(node, Some(script))` (or `(exe, None)` for native targets) so we can skip `cmd.exe`.
#[cfg_attr(not(windows), allow(dead_code))]
fn resolve_npm_cmd_shim(
    shim: &Path,
    path_env: &str,
) -> Option<(std::path::PathBuf, Option<std::path::PathBuf>)> {
    let text = std::fs::read_to_string(shim).ok()?;
    let dir = shim.parent()?;
    let marker = "\"%dp0%\\";
    let line = text
        .lines()
        .rev()
        .find(|l| l.contains("%*") && l.contains(marker))?;
    let start = line.rfind(marker)? + marker.len();
    let rel = &line[start..];
    let rel = &rel[..rel.find('"')?];
    let target = rel
        .split(['\\', '/'])
        .filter(|s| !s.is_empty())
        .fold(dir.to_path_buf(), |p, s| p.join(s));
    if !target.is_file() {
        return None;
    }
    let ext = target
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("exe") => Some((target, None)),
        Some("js" | "cjs" | "mjs") => {
            let local = dir.join("node.exe");
            let node = if local.is_file() {
                local
            } else {
                path_env
                    .split(';')
                    .filter(|d| !d.trim().is_empty())
                    .map(|d| Path::new(d.trim()).join("node.exe"))
                    .find(|p| p.is_file())?
            };
            Some((node, Some(target)))
        }
        _ => None,
    }
}

#[cfg(windows)]
mod win {
    use std::os::windows::io::RawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    #[derive(Debug)]
    pub struct Job(HANDLE);
    // SAFETY: a job handle is a kernel object handle usable from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn create() -> Option<Job> {
            // SAFETY: Win32 calls with valid pointers; the handle is closed on drop.
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() {
                    return None;
                }
                let job = Job(h);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                (ok != 0).then_some(job)
            }
        }

        pub fn assign(&self, process: RawHandle) -> bool {
            // SAFETY: `process` is a live child handle owned by tokio's `Child`.
            unsafe { AssignProcessToJobObject(self.0, process as HANDLE) != 0 }
        }

        pub fn terminate(&self) {
            // SAFETY: valid job handle.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: closing our own handle; KILL_ON_JOB_CLOSE reaps any survivors.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_shell_arg_escaping_neutralizes_metacharacters() {
        assert_eq!(escape_windows_shell_arg("plain"), "^\"plain^\"");
        assert_eq!(
            escape_windows_shell_arg("a & calc"),
            "^\"a^ ^&^ calc^\"",
            "spaces and & are caret-escaped"
        );
        assert_eq!(
            escape_windows_shell_arg("%PATH%"),
            "^\"^%PATH^%^\"",
            "env expansion is blocked"
        );
        assert_eq!(
            escape_windows_shell_arg(r#"say "hi""#),
            r#"^"say^ \^"hi\^"^""#
        );
        assert_eq!(escape_windows_shell_arg(r"C:\dir\"), r#"^"C:\dir\\^""#);
    }

    #[test]
    fn cmd_line_rejects_newlines() {
        let err = cmd_shell_command_line(Path::new("x.cmd"), &["a\nb".into()]).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn resolves_npm_cmd_shim_to_node_script() {
        let dir = tempfile::tempdir().unwrap();
        let shim = dir.path().join("copilot.cmd");
        std::fs::write(
            &shim,
            "@ECHO off\r\nGOTO start\r\n:start\r\nSETLOCAL\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@github\\copilot\\index.js\" %*\r\n",
        )
        .unwrap();
        let script = dir.path().join("node_modules/@github/copilot/index.js");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(&script, "").unwrap();
        std::fs::write(dir.path().join("node.exe"), "").unwrap();
        let (exe, target) = resolve_npm_cmd_shim(&shim, "").unwrap();
        assert_eq!(exe, dir.path().join("node.exe"));
        assert_eq!(target.unwrap(), script);
    }

    #[test]
    fn batch_detection_is_case_insensitive() {
        assert!(is_batch_file(Path::new(r"C:\x\codex.CMD")));
        assert!(is_batch_file(Path::new("a.bat")));
        assert!(!is_batch_file(Path::new("codex.exe")));
    }

    #[cfg(unix)]
    mod unix {
        use super::super::*;
        use std::path::PathBuf;

        fn sh(script: &str) -> LaunchSpec {
            LaunchSpec {
                program: PathBuf::from("/bin/sh"),
                args: vec!["-c".into(), script.into()],
                ..Default::default()
            }
        }

        #[tokio::test]
        async fn echoes_stdin_lines_and_applies_env() {
            let mut spec =
                sh(r#"echo "env=$FOO-${BAR:-unset}"; while read l; do echo "got:$l"; done"#);
            spec.env_set = vec![("FOO".into(), "1".into())];
            spec.env_remove = vec!["BAR".into()];
            let mut p = spawn(&spec, &[("BAR".into(), "base".into())]).unwrap();
            let mut out = line_channel(p.stdout.take().unwrap());
            let mut stdin = p.stdin.take().unwrap();
            assert_eq!(out.recv().await.unwrap(), "env=1-unset");
            write_line(&mut stdin, r#"{"a":1}"#).await.unwrap();
            assert_eq!(out.recv().await.unwrap(), r#"got:{"a":1}"#);
            drop(stdin);
            assert_eq!(out.recv().await, None);
            let code = shutdown(&mut p.child, &p.tree, Duration::from_secs(2)).await;
            assert_eq!(code, Some(0));
        }

        #[tokio::test]
        async fn shutdown_kills_the_whole_group() {
            let dir = tempfile::tempdir().unwrap();
            let marker = dir.path().join("grandchild.pid");
            // The grandchild ignores stdin EOF and would outlive a plain kill(pid).
            let script = format!(
                "trap '' TERM; sleep 30 & echo $! > {}; echo ready; wait",
                marker.display()
            );
            let mut p = spawn(&sh(&script), &[]).unwrap();
            let mut out = line_channel(p.stdout.take().unwrap());
            assert_eq!(out.recv().await.unwrap(), "ready");
            let gpid: i32 = std::fs::read_to_string(&marker)
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            shutdown(&mut p.child, &p.tree, Duration::from_millis(100)).await;
            tokio::time::sleep(Duration::from_millis(200)).await;
            // SAFETY: probe-only signal 0.
            let alive = unsafe { libc::kill(gpid, 0) } == 0;
            assert!(!alive, "grandchild {gpid} survived tree teardown");
        }

        #[tokio::test]
        async fn run_capture_collects_output_and_times_out() {
            let out = run_capture(
                Path::new("/bin/sh"),
                &["-c", "echo 1.2.3; echo warn >&2; exit 3"],
                &[],
                Duration::from_secs(5),
            )
            .await
            .unwrap();
            assert_eq!(out.code, Some(3));
            assert_eq!(out.stdout.trim(), "1.2.3");
            assert_eq!(out.stderr.trim(), "warn");

            let err = run_capture(
                Path::new("/bin/sh"),
                &["-c", "sleep 10"],
                &[],
                Duration::from_millis(100),
            )
            .await
            .unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        }
    }
}

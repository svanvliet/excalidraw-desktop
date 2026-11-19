//! Test profiles (docs/collab-protocol.md §6): run a second instance on the
//! same machine via `--profile <name>` or `EXCALIDRAW_DESKTOP_PROFILE`.

pub const PROFILE_ENV: &str = "EXCALIDRAW_DESKTOP_PROFILE";
pub const BASE_RELAY_PORT: u16 = 4780;

/// Resolve the profile name. `--profile` wins over the env var. Names must
/// be 1–32 chars of `[A-Za-z0-9_-]`; anything else is ignored.
pub fn resolve_profile(args: &[String], env: Option<&str>) -> Option<String> {
    let mut from_args = None;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        if arg == "--profile" {
            from_args = it.next().cloned();
        } else if let Some(v) = arg.strip_prefix("--profile=") {
            from_args = Some(v.to_owned());
        }
    }
    let raw = from_args.or_else(|| env.map(str::to_owned))?;
    let name = raw.trim();
    if is_valid_profile(name) {
        Some(name.to_owned())
    } else {
        log::warn!("profile: ignoring invalid profile name {raw:?}");
        None
    }
}

fn is_valid_profile(name: &str) -> bool {
    (1..=32).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// FNV-1a 32-bit over the UTF-8 bytes. Mirrored in TS if the frontend needs
/// the same default port.
pub fn fnv1a32(s: &str) -> u32 {
    s.bytes().fold(0x811c_9dc5u32, |h, b| {
        (h ^ u32::from(b)).wrapping_mul(0x0100_0193)
    })
}

/// Default relay port: 4780, or `4780 + 1 + fnv1a32(name) % 100` for a profile.
pub fn default_relay_port(profile: Option<&str>) -> u16 {
    match profile {
        None => BASE_RELAY_PORT,
        Some(name) => BASE_RELAY_PORT + 1 + (fnv1a32(name) % 100) as u16,
    }
}

/// `name` or `name-<profile>`.
pub fn suffixed(name: &str, profile: Option<&str>) -> String {
    match profile {
        Some(p) => format!("{name}-{p}"),
        None => name.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn resolves_profile_from_args_and_env() {
        assert_eq!(resolve_profile(&args(&["app"]), None), None);
        assert_eq!(
            resolve_profile(&args(&["app", "--profile", "b"]), None).as_deref(),
            Some("b")
        );
        assert_eq!(
            resolve_profile(&args(&["app", "--profile=guest_2"]), Some("env")).as_deref(),
            Some("guest_2")
        );
        assert_eq!(
            resolve_profile(&args(&["app"]), Some("env")).as_deref(),
            Some("env")
        );
        assert_eq!(resolve_profile(&args(&["app", "--profile"]), None), None);
        assert_eq!(resolve_profile(&args(&["app"]), Some("../etc")), None);
        assert_eq!(resolve_profile(&args(&["app"]), Some("")), None);
    }

    #[test]
    fn fnv_vectors() {
        assert_eq!(fnv1a32(""), 0x811c_9dc5);
        assert_eq!(fnv1a32("a"), 0xe40c_292c);
        assert_eq!(fnv1a32("foobar"), 0xbf9c_f968);
    }

    #[test]
    fn default_ports() {
        assert_eq!(default_relay_port(None), 4780);
        // fnv1a32("b") = 0xe70c2de5 = 3876335077 → % 100 = 77
        assert_eq!(default_relay_port(Some("b")), 4858);
        for name in ["a", "b", "guest", "test-profile"] {
            let p = default_relay_port(Some(name));
            assert!((4781..=4880).contains(&p));
        }
    }

    #[test]
    fn suffixes_names() {
        assert_eq!(suffixed("excalidraw-desktop", None), "excalidraw-desktop");
        assert_eq!(
            suffixed("excalidraw-desktop", Some("b")),
            "excalidraw-desktop-b"
        );
    }
}

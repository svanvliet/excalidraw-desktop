//! `add_image` file loading. A `path` argument is resolved here, in Rust, against the calling
//! session's folders (session folder + attached folder) and replaced with `data` + `mimeType`
//! before the call reaches the webview, so the webview never needs filesystem access.
//! Content checks (type/bytes match, SVG scripts, dimensions) run again in the webview, which
//! also handles images the agent passes inline.
use std::io::Read;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::Value;

use crate::agent::adapter::resolve_path;

pub const ADD_IMAGE_TOOL: &str = "add_image";
const APPLY_OPS_TOOL: &str = "apply_ops";
/// Largest image file the agent may place (decoded bytes). Mirrors `MAX_IMAGE_BYTES` in
/// `src/agent/scene/images.ts`.
pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

/// Identify an allowed image type from its leading bytes.
pub fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    let text = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let start = text.iter().position(|b| !b.is_ascii_whitespace())?;
    let head = &text[start..text.len().min(start + 4096)];
    if head.first() == Some(&b'<')
        && String::from_utf8_lossy(head)
            .to_ascii_lowercase()
            .contains("<svg")
    {
        return Some("image/svg+xml");
    }
    None
}

/// Canonical path of an existing file inside one of `roots`. Relative paths resolve against
/// `roots[0]` (the engine's cwd). `..`, symlinks and `~` that leave every root are rejected.
pub fn resolve_image_path(path: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let Some(base) = roots.first() else {
        return Err("Images can only be loaded from the conversation's folders, and this session has none. Pass data + mimeType instead.".into());
    };
    let outside = || {
        format!(
            "\"{path}\" is outside the conversation's folders ({}). Only files in the session folder or the attached folder can be placed.",
            roots
                .iter()
                .map(|r| r.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    let lexical = resolve_path(Path::new(path), base).ok_or_else(outside)?;
    if !roots.iter().any(|r| lexical.starts_with(r)) {
        return Err(outside());
    }
    // Resolve every symlink (including the file itself) and re-check containment.
    let canon = lexical
        .canonicalize()
        .map_err(|_| format!("Image file \"{path}\" was not found"))?;
    if !roots.iter().any(|r| canon.starts_with(r)) {
        return Err(outside());
    }
    if !canon.is_file() {
        return Err(format!("\"{path}\" is not a file"));
    }
    Ok(canon)
}

/// Read an image file from the session's folders: `(bytes, mime type)`.
pub fn load_image(path: &str, roots: &[PathBuf]) -> Result<(Vec<u8>, &'static str), String> {
    let file = resolve_image_path(path, roots)?;
    let too_big = || {
        format!(
            "Image \"{path}\" is larger than the {} MB limit",
            MAX_IMAGE_BYTES / 1024 / 1024
        )
    };
    let f = std::fs::File::open(&file).map_err(|e| format!("Can't read \"{path}\": {e}"))?;
    if f.metadata().map(|m| m.len()).unwrap_or(0) > MAX_IMAGE_BYTES {
        return Err(too_big());
    }
    let mut bytes = Vec::new();
    f.take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Can't read \"{path}\": {e}"))?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(too_big());
    }
    let mime = sniff_mime(&bytes).ok_or_else(|| {
        format!("\"{path}\" is not a supported image (png, jpeg, gif, webp or svg)")
    })?;
    Ok((bytes, mime))
}

fn inline_one(args: &mut Value, roots: &[PathBuf]) -> Result<(), String> {
    let Some(obj) = args.as_object_mut() else {
        return Ok(());
    };
    let Some(path) = obj.get("path") else {
        return Ok(());
    };
    let Some(path) = path.as_str().map(str::to_owned) else {
        return Err("\"path\" must be a string".into());
    };
    if obj.contains_key("data") {
        return Err("Pass either \"path\" or \"data\", not both".into());
    }
    let (bytes, mime) = load_image(&path, roots)?;
    if let Some(declared) = obj.get("mimeType").and_then(Value::as_str) {
        let declared = declared
            .to_ascii_lowercase()
            .replace("image/jpg", "image/jpeg");
        if declared != mime {
            return Err(format!(
                "\"{path}\" is {mime}, but mimeType says {declared}"
            ));
        }
    }
    obj.remove("path");
    obj.insert(
        "data".into(),
        Value::String(base64::engine::general_purpose::STANDARD.encode(bytes)),
    );
    obj.insert("mimeType".into(), Value::String(mime.into()));
    Ok(())
}

/// Replace every `add_image` `path` (top level, or inside `apply_ops`) with the file's bytes.
/// Other tools are left untouched.
pub fn inline_image_paths(tool: &str, args: &mut Value, roots: &[PathBuf]) -> Result<(), String> {
    match tool {
        ADD_IMAGE_TOOL => inline_one(args, roots),
        APPLY_OPS_TOOL => {
            let Some(ops) = args.get_mut("ops").and_then(Value::as_array_mut) else {
                return Ok(());
            };
            for (i, op) in ops.iter_mut().enumerate() {
                if op.get("tool").and_then(Value::as_str) != Some(ADD_IMAGE_TOOL) {
                    continue;
                }
                if let Some(op_args) = op.get_mut("args") {
                    inline_one(op_args, roots).map_err(|e| {
                        format!("ops[{i}] (add_image) failed: {e}; no changes were applied")
                    })?;
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x02\0\0\0\x01\x08\x06\0\0\0";

    struct Fx {
        _tmp: tempfile::TempDir,
        session: PathBuf,
        attached: PathBuf,
        outside: PathBuf,
    }

    fn fx() -> Fx {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let (session, attached, outside) = (
            base.join("session"),
            base.join("attached"),
            base.join("outside"),
        );
        for d in [&session, &attached, &outside] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(session.join("photo.png"), PNG).unwrap();
        std::fs::write(
            attached.join("logo.svg"),
            "<svg xmlns='http://www.w3.org/2000/svg'/>",
        )
        .unwrap();
        std::fs::write(outside.join("secret.png"), PNG).unwrap();
        Fx {
            _tmp: tmp,
            session,
            attached,
            outside,
        }
    }

    impl Fx {
        fn roots(&self) -> Vec<PathBuf> {
            vec![self.session.clone(), self.attached.clone()]
        }
    }

    #[test]
    fn sniffs_allowed_types_only() {
        assert_eq!(sniff_mime(PNG), Some("image/png"));
        assert_eq!(sniff_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff_mime(b"GIF89a..."), Some("image/gif"));
        assert_eq!(sniff_mime(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(
            sniff_mime(b"\xEF\xBB\xBF  <?xml version='1.0'?><svg/>"),
            Some("image/svg+xml")
        );
        assert_eq!(sniff_mime(b"hello <svg>"), None);
        assert_eq!(sniff_mime(b"%PDF-1.7"), None);
        assert_eq!(sniff_mime(b""), None);
    }

    #[test]
    fn loads_relative_and_absolute_paths_inside_either_root() {
        let f = fx();
        let (bytes, mime) = load_image("photo.png", &f.roots()).unwrap();
        assert_eq!((bytes.as_slice(), mime), (PNG, "image/png"));
        let abs = f.attached.join("logo.svg");
        assert_eq!(
            load_image(abs.to_str().unwrap(), &f.roots()).unwrap().1,
            "image/svg+xml"
        );
        assert!(load_image("./sub/../photo.png", &f.roots()).is_ok());
    }

    #[test]
    fn rejects_traversal_absolute_and_home_escapes() {
        let f = fx();
        let roots = f.roots();
        for p in [
            "../outside/secret.png".to_owned(),
            "../../etc/passwd".to_owned(),
            f.outside.join("secret.png").display().to_string(),
            "~/secret.png".to_owned(),
        ] {
            let err = load_image(&p, &roots).unwrap_err();
            assert!(
                err.contains("outside the conversation's folders"),
                "{p}: {err}"
            );
        }
        assert!(load_image("photo.png", &[])
            .unwrap_err()
            .contains("data + mimeType"));
        assert!(load_image("missing.png", &roots)
            .unwrap_err()
            .contains("not found"));
        assert!(load_image(".", &roots).unwrap_err().contains("not a file"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escapes() {
        let f = fx();
        let roots = f.roots();
        std::os::unix::fs::symlink(f.outside.join("secret.png"), f.session.join("link.png"))
            .unwrap();
        std::os::unix::fs::symlink(&f.outside, f.session.join("dir")).unwrap();
        for p in ["link.png", "dir/secret.png", "dir/../outside/secret.png"] {
            let err = load_image(p, &roots).unwrap_err();
            assert!(err.contains("outside"), "{p}: {err}");
        }
        // A symlink that stays inside the roots is fine.
        std::os::unix::fs::symlink(f.attached.join("logo.svg"), f.session.join("ok.svg")).unwrap();
        assert!(load_image("ok.svg", &roots).is_ok());
    }

    #[test]
    fn rejects_oversized_and_non_image_files() {
        let f = fx();
        std::fs::write(f.session.join("notes.txt"), "just text").unwrap();
        assert!(load_image("notes.txt", &f.roots())
            .unwrap_err()
            .contains("not a supported image"));
        let big = std::fs::File::create(f.session.join("big.png")).unwrap();
        big.set_len(MAX_IMAGE_BYTES + 1).unwrap();
        assert!(load_image("big.png", &f.roots())
            .unwrap_err()
            .contains("10 MB"));
    }

    #[test]
    fn inlines_paths_for_add_image_and_apply_ops() {
        let f = fx();
        let mut args = json!({ "path": "photo.png", "x": 5 });
        inline_image_paths("add_image", &mut args, &f.roots()).unwrap();
        assert!(args.get("path").is_none());
        assert_eq!(args["mimeType"], "image/png");
        assert_eq!(args["x"], 5);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(args["data"].as_str().unwrap())
            .unwrap();
        assert_eq!(decoded, PNG);

        let logo = f.attached.join("logo.svg");
        let mut ops = json!({ "ops": [
            { "tool": "add_elements", "args": { "path": "untouched" } },
            { "tool": "add_image", "args": { "path": logo } },
        ]});
        inline_image_paths("apply_ops", &mut ops, &f.roots()).unwrap();
        assert_eq!(ops["ops"][0]["args"]["path"], "untouched");
        assert_eq!(ops["ops"][1]["args"]["mimeType"], "image/svg+xml");

        let mut bad = json!({ "ops": [{ "tool": "add_image", "args": { "path": "../outside/secret.png" } }] });
        let err = inline_image_paths("apply_ops", &mut bad, &f.roots()).unwrap_err();
        assert!(err.starts_with("ops[0] (add_image) failed"), "{err}");

        let mut both = json!({ "path": "photo.png", "data": "AAAA" });
        assert!(inline_image_paths("add_image", &mut both, &f.roots()).is_err());
        let mut mismatch = json!({ "path": "photo.png", "mimeType": "image/gif" });
        assert!(inline_image_paths("add_image", &mut mismatch, &f.roots())
            .unwrap_err()
            .contains("mimeType says image/gif"));
        let mut other = json!({ "path": "../outside/secret.png" });
        inline_image_paths("add_elements", &mut other, &f.roots()).unwrap();
        assert_eq!(other["path"], "../outside/secret.png");
    }
}

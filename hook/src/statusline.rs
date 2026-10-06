//! `koukou-hook Statusline` — Koukou's statusLine command.
//!
//! The statusLine JSON is the only place Claude Code reports plan usage (the
//! 5-hour and 7-day windows), so Koukou has to sit in that slot. But there is
//! only one slot, and the user may already have a status line of their own.
//! So this does two things at once:
//!
//! * forwards the session id and `rate_limits` to Koukou, fire-and-forget, and
//! * runs the user's original statusLine command with the same stdin and prints
//!   whatever it prints — their status line looks exactly as before.
//!
//! The original command is saved by the installer in
//! `%LOCALAPPDATA%\Koukou\statusline-chain.json`. No file, no chained command:
//! we print nothing, which is what having no status line looks like.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

/// A status line that takes longer than this is not worth waiting for; Claude
/// Code would cancel us on the next update anyway.
const CHAIN_BUDGET: Duration = Duration::from_secs(8);
/// How long we let the forward to Koukou finish once the line is printed.
const FORWARD_GRACE: Duration = Duration::from_millis(400);
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn chain_path() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(Path::new(&base).join("Koukou").join("statusline-chain.json"))
}

pub fn run() {
    let mut raw = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut raw);
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        raw.drain(..3);
    }

    // Forward first, in the background: Koukou being slow or closed must never
    // hold up the user's own status line.
    let (tx, rx) = mpsc::channel::<()>();
    if let Some(line) = forward_payload(&raw) {
        std::thread::spawn(move || {
            let _ = crate::talk(&line, false);
            let _ = tx.send(());
        });
    }

    if let Some(out) = run_chain(&raw) {
        let mut stdout = std::io::stdout();
        let _ = stdout.write_all(&out);
        let _ = stdout.flush();
    }

    let _ = rx.recv_timeout(FORWARD_GRACE);
}

/// Just what the island needs: who, where, and the usage windows.
fn forward_payload(raw: &[u8]) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(raw).ok()?;
    let cwd = v
        .get("cwd")
        .or_else(|| v.get("workspace").and_then(|w| w.get("current_dir")))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let payload = serde_json::json!({
        "hook_event_name": "Statusline",
        "session_id": v.get("session_id").cloned().unwrap_or(serde_json::Value::Null),
        "cwd": cwd,
        "rate_limits": v.get("rate_limits").cloned().unwrap_or(serde_json::Value::Null),
    });
    let mut line = payload.to_string();
    line.push('\n');
    Some(line)
}

/// Runs the user's original statusLine command and returns its stdout.
fn run_chain(raw: &[u8]) -> Option<Vec<u8>> {
    let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(chain_path()?).ok()?).ok()?;
    let command = saved.get("command")?.as_str()?.trim().to_string();
    if command.is_empty() || command.contains(crate::MARKER) {
        return None; // never call ourselves
    }

    let mut child = shell(&command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let mut stdin = child.stdin.take()?;
    let input = raw.to_vec();
    std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
        // Dropping stdin closes it, so the command sees the end of its input.
    });

    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        let _ = tx.send(out);
    });

    match rx.recv_timeout(CHAIN_BUDGET) {
        Ok(out) => {
            let _ = child.wait();
            Some(out)
        }
        Err(_) => {
            let _ = child.kill();
            None
        }
    }
}

/// The same shell Claude Code uses for commands on Windows: Git Bash. cmd is
/// only a last resort, for a machine where Bash cannot be found at all.
fn shell(command: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = match bash_path() {
        Some(bash) => {
            let mut c = Command::new(bash);
            c.arg("-c").arg(command);
            c
        }
        None => {
            let mut c = Command::new("cmd");
            c.arg("/C").raw_arg(command);
            c
        }
    };
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

fn bash_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
    // Next to git.exe: Git\cmd → Git\bin\bash.exe, Git\mingw64\bin → Git\bin\bash.exe.
    for dir in &dirs {
        if dir.join("git.exe").is_file() {
            for candidate in [dir.join("..").join("bin").join("bash.exe"),
                              dir.join("..").join("..").join("bin").join("bash.exe"),
                              dir.join("bash.exe")] {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    // A bash.exe on PATH — but never System32's, which is WSL, not Git Bash.
    for dir in &dirs {
        let lower = dir.to_string_lossy().to_lowercase();
        if lower.contains("system32") || lower.contains("windowsapps") {
            continue;
        }
        let candidate = dir.join("bash.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let default = PathBuf::from(r"C:\Program Files\Git\bin\bash.exe");
    default.is_file().then_some(default)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forwards_only_what_the_island_needs() {
        let raw = br#"{"session_id":"s1","cwd":"E:/koukou","model":{"id":"x"},
            "rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1738425600}}}"#;
        let line = forward_payload(raw).unwrap();
        let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(v["hook_event_name"], "Statusline");
        assert_eq!(v["session_id"], "s1");
        assert_eq!(v["rate_limits"]["five_hour"]["used_percentage"], 23.5);
        assert!(v.get("model").is_none());
    }

    #[test]
    fn falls_back_to_the_workspace_dir() {
        let raw = br#"{"session_id":"s1","workspace":{"current_dir":"E:/x"}}"#;
        let v: serde_json::Value = serde_json::from_str(forward_payload(raw).unwrap().trim()).unwrap();
        assert_eq!(v["cwd"], "E:/x");
        assert!(v["rate_limits"].is_null());
    }
}

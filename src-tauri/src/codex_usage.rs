// Codex plan usage — the 5-hour and weekly windows.
//
// Codex has no status line, but every session log (`~/.codex/sessions/Y/M/D/
// rollout-*.jsonl`) gets a `token_count` event carrying `rate_limits` with a
// `primary` and a `secondary` window. The tail of the newest log is read once
// at launch and again after each Codex hook; the island keeps the latest value
// and hovering never triggers a read. Local files only: no network.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::island::WINDOW_LABEL;

/// How much of the end of a log to scan; one `token_count` line is a few KB.
const TAIL_BYTES: u64 = 256 * 1024;
const MAX_FILES: usize = 8;
/// A burst of hooks (tool calls) asks for one read, not one each.
const MIN_GAP: Duration = Duration::from_secs(3);

static LAST: Mutex<Option<(Instant, Option<Value>)>> = Mutex::new(None);

pub fn start(app: AppHandle) {
    refresh(app);
}

/// Reads the newest limits and emits them when they changed.
pub fn refresh(app: AppHandle) {
    {
        let mut last = LAST.lock().unwrap();
        if let Some((at, _)) = last.as_ref() {
            if at.elapsed() < MIN_GAP {
                return;
            }
        }
        let prev = last.take().and_then(|(_, v)| v);
        *last = Some((Instant::now(), prev));
    }
    tauri::async_runtime::spawn(async move {
        let found = tokio::task::spawn_blocking(read_latest).await.ok().flatten();
        let Some(usage) = found else { return };
        *LAST.lock().unwrap() = Some((Instant::now(), Some(usage.clone())));
        // Always emitted: the launch-time read can land before the island is
        // listening, so "unchanged" in here must not mean "already delivered".
        let _ = app.emit_to(WINDOW_LABEL, "codex-usage", usage);
    });
}

fn sessions_dir() -> PathBuf {
    crate::platform::home_dir().join(".codex").join("sessions")
}

/// Child entries of `dir`, newest name first (the layout is zero-padded Y/M/D).
fn children_desc(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok().map(|e| e.path())).collect())
        .unwrap_or_default();
    v.sort_by(|a, b| b.cmp(a));
    v
}

/// The newest rollout logs by modification time. A brand-new session has no
/// `token_count` yet, so this walks back through day folders until it has a few.
fn newest_logs() -> Vec<PathBuf> {
    let mut found: Vec<(SystemTime, PathBuf)> = Vec::new();
    'walk: for year in children_desc(&sessions_dir()) {
        for month in children_desc(&year) {
            for day in children_desc(&month) {
                let files = std::fs::read_dir(&day).into_iter().flatten().filter_map(|e| {
                    let p = e.ok()?.path();
                    let ok = p.extension().is_some_and(|x| x == "jsonl");
                    let modified = p.metadata().ok()?.modified().ok()?;
                    ok.then_some((modified, p))
                });
                found.extend(files);
                if found.len() >= MAX_FILES {
                    break 'walk;
                }
            }
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().take(MAX_FILES).map(|f| f.1).collect()
}

fn read_latest() -> Option<Value> {
    newest_logs().iter().find_map(|path| usage_from_log(path))
}

fn usage_from_log(path: &Path) -> Option<Value> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);

    for line in text.lines().rev() {
        if !line.contains("rate_limits") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let Some(limits) = v.pointer("/payload/rate_limits").filter(|l| l.is_object()) else { continue };
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        let mut five = Value::Null;
        let mut seven = Value::Null;
        for key in ["primary", "secondary"] {
            let Some(w) = limits.get(key).filter(|w| w.is_object()) else { continue };
            let Some(pct) = w.get("used_percent").and_then(Value::as_f64) else { continue };
            let resets_at = w
                .get("resets_at")
                .and_then(Value::as_f64)
                .or_else(|| w.get("resets_in_seconds").and_then(Value::as_f64).map(|s| now + s));
            let Some(resets_at) = resets_at else { continue };
            let minutes = w.get("window_minutes").and_then(Value::as_f64).unwrap_or(0.0);
            let window = json!({ "pct": pct, "resetsAt": resets_at });
            // Short windows are the 5-hour one; anything longer counts as weekly.
            if minutes > 0.0 && minutes <= 360.0 {
                five = window;
            } else if minutes > 360.0 || key == "secondary" {
                seven = window;
            } else {
                five = window;
            }
        }
        return Some(json!({ "fiveHour": five, "sevenDay": seven }));
    }
    None
}

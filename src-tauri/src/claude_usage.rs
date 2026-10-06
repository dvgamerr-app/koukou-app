// Claude plan usage when the status line hasn't reported it (the VS Code
// extension never runs one), plus a small on-disk cache of the last known
// limits of both Claude and Codex so a restart doesn't start from n/a.
//
// The fetch only happens when the island asks for it — hovering over limits
// that are still n/a — and at most once a minute. It reads Claude Code's own
// OAuth access token from `~/.claude/.credentials.json` at call time; the token
// is never copied, logged or stored by Koukou. The cache holds percentages and
// reset times only.

use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::island::WINDOW_LABEL;
use crate::log;

const URL: &str = "https://api.anthropic.com/api/oauth/usage";
const MIN_GAP: Duration = Duration::from_secs(60);

static LAST: Mutex<Option<Instant>> = Mutex::new(None);

fn now_s() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// Days since 1970-01-01 for a proleptic Gregorian date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// "2026-10-06T19:29:59.98+00:00" → epoch seconds.
fn parse_iso(s: &str) -> Option<f64> {
    let (date, rest) = s.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, mo, da) = (d.next()??, d.next()??, d.next()??);
    let time_end = rest.find(['+', '-', 'Z']).unwrap_or(rest.len());
    let (time, zone) = rest.split_at(time_end);
    let mut t = time.split(':');
    let h: f64 = t.next()?.parse().ok()?;
    let mi: f64 = t.next()?.parse().ok()?;
    let sec: f64 = t.next().unwrap_or("0").parse().ok()?;
    let offset = match zone.chars().next() {
        Some(sign @ ('+' | '-')) => {
            let (zh, zm) = zone[1..].split_once(':').unwrap_or((&zone[1..], "0"));
            let secs = zh.parse::<f64>().ok()? * 3600.0 + zm.parse::<f64>().ok()? * 60.0;
            if sign == '+' { secs } else { -secs }
        }
        _ => 0.0,
    };
    Some(days_from_civil(y, mo, da) as f64 * 86400.0 + h * 3600.0 + mi * 60.0 + sec - offset)
}

fn window(v: &Value) -> Value {
    let pct = v.get("utilization").and_then(Value::as_f64);
    let resets = v.get("resets_at").and_then(Value::as_str).and_then(parse_iso);
    match (pct, resets) {
        (Some(pct), Some(resets_at)) => json!({ "pct": pct, "resetsAt": resets_at }),
        _ => Value::Null,
    }
}

fn access_token() -> Option<String> {
    let path = crate::platform::home_dir().join(".claude").join(".credentials.json");
    let v: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    let oauth = v.get("claudeAiOauth")?;
    // Claude Code refreshes its own token; an expired one just means "not now".
    if oauth.get("expiresAt").and_then(Value::as_f64).is_some_and(|ms| ms / 1000.0 <= now_s()) {
        return None;
    }
    oauth.get("accessToken").and_then(Value::as_str).map(str::to_owned)
}

/// Asks Anthropic for the current limits and emits them as `claude-usage`.
pub fn refresh(app: AppHandle) {
    if crate::integrations::PAUSED.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    {
        let mut last = LAST.lock().unwrap();
        if last.is_some_and(|at| at.elapsed() < MIN_GAP) {
            return;
        }
        *last = Some(Instant::now());
    }
    tauri::async_runtime::spawn(async move {
        let Some(token) = access_token() else { return };
        let client = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().unwrap_or_default();
        let res = client
            .get(URL)
            .bearer_auth(token)
            .header("anthropic-beta", "oauth-2025-04-20")
            .send()
            .await;
        let body: Value = match res {
            Ok(r) if r.status().is_success() => match r.text().await.ok().and_then(|t| serde_json::from_str(&t).ok()) {
                Some(v) => v,
                None => return,
            },
            Ok(r) => {
                log::line(format!("claude usage: HTTP {}", r.status()));
                return;
            }
            Err(_) => return,
        };
        let usage = json!({
            "fiveHour": window(&body["five_hour"]),
            "sevenDay": window(&body["seven_day"]),
        });
        let _ = app.emit_to(WINDOW_LABEL, "claude-usage", usage);
    });
}

// ── Cache ─────────────────────────────────────────────────────────────────────

fn cache_path() -> std::path::PathBuf {
    crate::settings::config_dir().join("usage-cache.json")
}

pub fn cache_load() -> Value {
    std::fs::read(cache_path())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}

pub fn cache_save(value: &Value) {
    let dir = crate::settings::config_dir();
    if crate::platform::ensure_private_dir(&dir).is_ok() {
        if let Ok(json) = serde_json::to_vec(value) {
            let _ = std::fs::write(cache_path(), json);
        }
    }
}

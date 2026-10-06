//! coucou-hook — the relay Claude Code runs on every hook event.
//!
//! Reads the hook JSON on stdin, adds a little terminal context, and hands it to
//! Coucou over the named pipe `\\.\pipe\coucou-<sid>` (Windows) or the Unix
//! socket `$XDG_RUNTIME_DIR/coucou.sock` (Linux).
//!
//! Hard rule (docs/CLAUDE.md): **never block Claude Code.**
//! * If the pipe does not exist — Coucou is closed — we exit 0 immediately with
//!   nothing on stdout, and the session carries on untouched.
//! * Every step runs under a deadline enforced by the main thread, so a pipe that
//!   accepts the connection and then stops reading cannot wedge the session
//!   either: we abandon the worker and exit.
//! * Only `PermissionRequest` waits for an answer, because approving from the
//!   island is the whole point. No answer means empty stdout, and Claude Code
//!   asks in the terminal exactly as if Coucou were not installed.
//!
//! Usage: `coucou-hook <EventName>` (the name is also read from the JSON).

use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::Duration;

/// Budget for getting a pipe connection. Beyond this Claude Code wins, always.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
/// Whole-run budget for an event nobody waits on: connect and write, no more.
const FIRE_AND_FORGET_BUDGET: Duration = Duration::from_secs(2);
/// How long a permission prompt may stay on screen before the terminal takes over.
const DECISION_BUDGET: Duration = Duration::from_secs(110);

/// Fields that are pointless to forward and can be enormous (a whole file read,
/// a full command output). The island never shows them.
const DROPPED_FIELDS: &[&str] = &["tool_response", "transcript_path"];
/// Longest string forwarded for any single field; the island truncates to far
/// less than this anyway.
const MAX_FIELD_LEN: usize = 2_000;

/// Events that carry the session's process chain (see `win::ancestor_pids`).
const WINDOW_EVENTS: &[&str] = &["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "PermissionRequest"];

/// Part of every command Coucou writes into settings.json (the exe name).
const MARKER: &str = "coucou-hook";

mod statusline;
#[cfg(windows)]
mod win;
#[cfg(windows)]
use win::connect;

#[cfg(target_os = "linux")]
mod unix;
#[cfg(target_os = "linux")]
use unix::connect;

fn main() {
    let codex = std::env::args().any(|arg| arg == "--codex");
    // The statusLine has its own contract: stdout is the status line itself.
    if std::env::args().nth(1).as_deref() == Some("Statusline") {
        statusline::run();
        std::process::exit(0);
    }

    // A disconnected stdin must not leave an orphaned Codex hook waiting for
    // console input forever, before the pipe deadline even starts.
    let input = if codex {
        let (input_tx, input_rx) = mpsc::channel();
        std::thread::spawn(move || { let _ = input_tx.send(read_event()); });
        input_rx.recv_timeout(FIRE_AND_FORGET_BUDGET).ok().flatten()
    } else {
        read_event()
    };
    let Some((payload, event, ask_input)) = input else { std::process::exit(0) };

    let waits_for_answer = event == "PermissionRequest";
    let budget = if waits_for_answer { DECISION_BUDGET } else { FIRE_AND_FORGET_BUDGET };

    // The worker owns every blocking call. If it overruns the budget we simply
    // stop listening and exit: the process dying takes the pipe handle with it.
    // (No catch_unwind here — the release profile is panic = "abort", so it would
    // be dead code. `talk` is written to have nothing to panic on instead.)
    let (tx, rx) = mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let _ = tx.send(talk(&payload, waits_for_answer));
    });

    if let Ok(Some(decision)) = rx.recv_timeout(budget) {
        if let Some(json) = decision_json(&decision, ask_input.as_ref()) {
            let mut out = std::io::stdout();
            let _ = writeln!(out, "{json}");
            let _ = out.flush();
        }
    }
    if codex && matches!(event.as_str(), "Stop" | "SubagentStop") {
        println!("{{}}");
    }
    // Nothing printed: Claude Code asks in the terminal, as if we were not here.
    std::process::exit(0);
}

/// The documented PermissionRequest output. Anything we do not recognise prints
/// nothing at all rather than guessing — silence is the safe answer.
/// See https://code.claude.com/docs/en/hooks
///
/// `ask_input` is the untruncated `tool_input` of an AskUserQuestion. Its
/// answer arrives as `answer [[i], [j, k]]` (option indices per question) and
/// goes back as an allow whose `updatedInput` carries the questions plus
/// `answers` — question text → chosen label(s), the shape documented for
/// AskUserQuestion in https://code.claude.com/docs/en/agent-sdk/user-input
fn decision_json(decision: &str, ask_input: Option<&serde_json::Value>) -> Option<String> {
    let decision = decision.trim();
    if let Some(list) = decision.strip_prefix("answer ") {
        let updated = answered_input(ask_input?, list)?;
        let out = serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": { "behavior": "allow", "updatedInput": updated },
            }
        });
        return Some(out.to_string());
    }
    let behavior = match decision {
        // "always" still answers a plain allow; remembering it is the island's
        // business, not Claude Code's.
        "allow" | "always" => r#"{"behavior":"allow"}"#.to_string(),
        "deny" => r#"{"behavior":"deny","message":"Denied from Coucou"}"#.to_string(),
        _ => return None,
    };
    Some(format!(
        r#"{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","decision":{behavior}}}}}"#
    ))
}

/// The AskUserQuestion input with `answers` filled in, or None if the choices
/// do not fit the questions — every question answered, every index real, one
/// pick for a single-choice question. A wrong answer is worse than none.
fn answered_input(input: &serde_json::Value, list: &str) -> Option<serde_json::Value> {
    let choices: Vec<Vec<usize>> = serde_json::from_str(list).ok()?;
    let questions = input.get("questions")?.as_array()?;
    if choices.len() != questions.len() {
        return None;
    }
    let mut answers = serde_json::Map::new();
    for (q, picked) in questions.iter().zip(&choices) {
        let text = q.get("question")?.as_str()?;
        let options = q.get("options")?.as_array()?;
        let multi = q.get("multiSelect").and_then(|v| v.as_bool()).unwrap_or(false);
        if picked.is_empty() || (!multi && picked.len() != 1) {
            return None;
        }
        let labels = picked
            .iter()
            .map(|&i| options.get(i)?.get("label")?.as_str())
            .collect::<Option<Vec<_>>>()?;
        answers.insert(text.to_string(), serde_json::Value::String(labels.join(", ")));
    }
    let mut updated = input.clone();
    updated.as_object_mut()?.insert("answers".into(), serde_json::Value::Object(answers));
    Some(updated)
}

/// Reads stdin and returns the payload to forward, the event name and, for an
/// AskUserQuestion permission request, the tool input before truncation.
fn read_event() -> Option<(String, String, Option<serde_json::Value>)> {
    let mut raw = Vec::new();
    if std::io::stdin().read_to_end(&mut raw).is_err() || raw.is_empty() {
        return None;
    }
    // Some shells hand us a UTF-8 BOM; serde_json would choke on it.
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        raw.drain(..3);
    }

    let mut payload = serde_json::from_slice::<serde_json::Value>(&raw).ok()?;
    let map = payload.as_object_mut()?;

    // Parse argv: "coucou-hook.exe [--agent <name>] [<EventName>]"
    // --agent tags the payload with coucou_agent so the app routes to the right pill.
    // Absent or invalid names are validated and discarded by the app, not here.
    let mut agent = String::new();
    let mut arg_event = String::new();
    {
        let mut it = std::env::args().skip(1);
        while let Some(arg) = it.next() {
            if arg == "--agent" {
                agent = it.next().unwrap_or_default();
            } else if arg_event.is_empty() {
                arg_event = arg;
            }
        }
    }
    // Which agent this hook was installed for. Absent means Claude Code,
    // so existing hook commands keep working unchanged.
    if !agent.is_empty() {
        map.insert("coucou_agent".into(), serde_json::Value::String(agent));
    }
    let event = map
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .unwrap_or(arg_event);
    map.insert("hook_event_name".into(), serde_json::Value::String(event.clone()));
    if std::env::args().any(|arg| arg == "--codex") {
        map.insert("provider".into(), serde_json::json!("codex"));
        if let Some(message) = map.get("last_assistant_message").cloned() {
            map.insert("message".into(), message);
        }
    }

    for field in DROPPED_FIELDS {
        map.remove(*field);
    }

    let cwd_missing = map
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(str::is_empty)
        .unwrap_or(true);
    if cwd_missing {
        if let Ok(cwd) = std::env::current_dir() {
            map.insert(
                "cwd".into(),
                serde_json::Value::String(cwd.to_string_lossy().to_string()),
            );
        }
    }

    // Which terminal the session runs in. Unlike macOS, Coucou here accepts
    // events from every terminal, so this is context only — never a filter.
    for (key, var) in [
        ("term_program", "TERM_PROGRAM"),
        ("wt_session", "WT_SESSION"),
        ("term_session_id", "TERM_SESSION_ID"),
        ("vscode_pid", "VSCODE_PID"),
        ("session_pid", "CLAUDE_CODE_SSE_PORT"),
    ] {
        if !map.contains_key(key) {
            let value = std::env::var(var).unwrap_or_default();
            map.insert(key.into(), serde_json::Value::String(value));
        }
    }

    // Where the session's window is, so "Open terminal" can bring that very
    // window forward. Walking the process tree costs a few milliseconds, so only
    // the events that start or end a turn carry it — not every tool call.
    if WINDOW_EVENTS.contains(&event.as_str()) {
        map.insert("ancestor_pids".into(), serde_json::json!(win::ancestor_pids()));
        if let Some(hwnd) = win::console_window() {
            map.insert("console_hwnd".into(), serde_json::json!(hwnd));
        }
    }

    // The island only sees a truncated copy; answering needs the real questions.
    let is_ask = map.get("tool_name").and_then(|v| v.as_str()) == Some("AskUserQuestion");
    let ask_input = if event == "PermissionRequest" && is_ask {
        map.get("tool_input").cloned()
    } else {
        None
    };

    truncate_strings(&mut payload);

    let mut line = payload.to_string();
    line.push('\n');
    Some((line, event, ask_input))
}

/// Caps every string in the payload. A single Write can carry a whole file.
fn truncate_strings(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(s) => {
            if s.len() > MAX_FIELD_LEN {
                // Cut on a char boundary; a lone byte index can split UTF-8.
                let mut end = MAX_FIELD_LEN;
                while end > 0 && !s.is_char_boundary(end) {
                    end -= 1;
                }
                s.truncate(end);
                s.push('…');
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(truncate_strings),
        serde_json::Value::Object(map) => map.values_mut().for_each(truncate_strings),
        _ => {}
    }
}

/// Connect, send, and — for a permission request — wait for the island's word.
fn talk(payload: &str, waits_for_answer: bool) -> Option<String> {
    let mut pipe = connect()?;

    if pipe.write_all(payload.as_bytes()).is_err() {
        return None;
    }
    let _ = pipe.flush();

    if !waits_for_answer {
        return None;
    }

    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let answer = String::from_utf8_lossy(&buf).trim().to_string();
    (!answer.is_empty()).then_some(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_json_matches_the_documented_shape() {
        assert_eq!(
            decision_json("allow", None).unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
        );
        assert_eq!(
            decision_json("deny", None).unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Coucou"}}}"#
        );
        // "always" is an island concept; Claude Code just gets an allow.
        assert!(decision_json("always", None).unwrap().contains(r#""behavior":"allow""#));
    }

    #[test]
    fn anything_unrecognised_prints_nothing() {
        assert!(decision_json("", None).is_none());
        assert!(decision_json("maybe", None).is_none());
        // The shape the app used to send must not be mistaken for a decision.
        assert!(decision_json(r#"{"permissionDecision":"allow"}"#, None).is_none());
    }

    fn ask_input() -> serde_json::Value {
        serde_json::json!({ "questions": [
            { "question": "Which PR?", "header": "PR", "multiSelect": false,
              "options": [{ "label": "Update #5" }, { "label": "New PR" }] },
            { "question": "Which checks?", "header": "CI", "multiSelect": true,
              "options": [{ "label": "lint" }, { "label": "test" }, { "label": "build" }] },
        ]})
    }

    #[test]
    fn an_answer_becomes_allow_with_answers() {
        let input = ask_input();
        let json = decision_json("answer [[1],[0,2]]", Some(&input)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        let d = &v["hookSpecificOutput"]["decision"];
        assert_eq!(d["behavior"], "allow");
        assert_eq!(d["updatedInput"]["answers"]["Which PR?"], "New PR");
        assert_eq!(d["updatedInput"]["answers"]["Which checks?"], "lint, build");
        assert_eq!(d["updatedInput"]["questions"], input["questions"]);
    }

    #[test]
    fn a_bad_answer_prints_nothing() {
        let input = ask_input();
        // Out of range, a question left out, two picks on a single choice, no input.
        assert!(decision_json("answer [[5],[0]]", Some(&input)).is_none());
        assert!(decision_json("answer [[0]]", Some(&input)).is_none());
        assert!(decision_json("answer [[0,1],[0]]", Some(&input)).is_none());
        assert!(decision_json("answer [[0],[]]", Some(&input)).is_none());
        assert!(decision_json("answer [[0],[0]]", None).is_none());
    }

    #[test]
    fn long_strings_are_cut_on_a_char_boundary() {
        let mut v = serde_json::json!({ "tool_input": { "content": "é".repeat(4000) } });
        truncate_strings(&mut v);
        let s = v["tool_input"]["content"].as_str().unwrap();
        assert!(s.len() <= MAX_FIELD_LEN + 4);
        assert!(s.ends_with('…'));
    }
}

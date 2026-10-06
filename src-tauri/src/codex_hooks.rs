use crate::{
    hooks::{self, HookPreview, HookStatus},
    settings,
};
use serde_json::{json, Value};
use std::path::PathBuf;

const EVENTS: &[(&str, u64)] = &[
    ("SessionStart", 10),
    ("SessionEnd", 3),
    ("UserPromptSubmit", 10),
    ("PreToolUse", 10),
    ("PostToolUse", 10),
    ("PermissionRequest", 120),
    ("Stop", 10),
    ("SubagentStart", 10),
    ("SubagentStop", 10),
    ("Interrupt", 3),
];

fn path() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default()).join(".codex")
        })
        .join("hooks.json")
}

fn read() -> Result<(Value, String), String> {
    let p = path();
    match std::fs::read(&p) {
        Ok(bytes) => Ok((
            hooks::parse_settings(&bytes, &p.display().to_string())?,
            hooks::fingerprint(&bytes),
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok((json!({}), hooks::fingerprint(b"")))
        }
        Err(e) => Err(format!("Can't read {}: {e}", p.display())),
    }
}

fn ours(handler: &Value) -> bool {
    ["command", "commandWindows"].iter().any(|key| {
        handler
            .get(*key)
            .and_then(Value::as_str)
            .map(|s| s.contains("coucou-hook") && s.contains("--codex"))
            .unwrap_or(false)
    })
}

fn changed(current: &Value, install: bool) -> Result<Value, String> {
    let mut next = current.clone();
    let root = next.as_object_mut().ok_or("hooks.json must be an object")?;
    if !root.contains_key("hooks") {
        root.insert("hooks".into(), json!({}));
    }
    let all = root
        .get_mut("hooks")
        .and_then(Value::as_object_mut)
        .ok_or("hooks must be an object; Coucou won't overwrite it")?;
    let mut empty_events = Vec::new();
    for (event, groups) in all.iter_mut() {
        let groups = groups
            .as_array_mut()
            .ok_or("Hook event must contain an array")?;
        let mut empty_groups = Vec::new();
        for (index, group) in groups.iter_mut().enumerate() {
            let handlers = group
                .get_mut("hooks")
                .and_then(Value::as_array_mut)
                .ok_or("Hook group must contain a hooks array")?;
            let had_ours = handlers.iter().any(ours);
            handlers.retain(|h| !ours(h));
            if had_ours && handlers.is_empty() {
                empty_groups.push(index);
            }
        }
        if !empty_groups.is_empty() {
            for index in empty_groups.into_iter().rev() {
                groups.remove(index);
            }
            if groups.is_empty() {
                empty_events.push(event.clone());
            }
        }
    }
    for event in empty_events {
        all.remove(&event);
    }
    if install {
        let exe = settings::hook_exe_path()
            .to_string_lossy()
            .replace('\\', "/");
        for (event, timeout) in EVENTS {
            // PowerShell's native call operator can create a console and leave
            // stdin disconnected. Launch with explicit pipes and no window.
            let budget = if *event == "PermissionRequest" { 110_000 } else { 2_000 };
            let command = include_str!("codex-hook-command.ps1")
                .replace("__EXE__", &exe.replace('\'', "''"))
                .replace("__EVENT__", event)
                .replace("__TIMEOUT_MS__", &budget.to_string());
            all.entry((*event).to_string())
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .ok_or("Hook event must contain an array")?
                .push(json!({"hooks":[{"type":"command","command":command,"timeout":timeout}]}));
        }
    }
    if all.is_empty() {
        root.remove("hooks");
    }
    Ok(next)
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

fn backup_path() -> PathBuf {
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    path().with_file_name(format!("hooks.json.bak-{time}"))
}

pub fn status() -> HookStatus {
    let installed = read()
        .ok()
        .map(|(v, _)| {
            EVENTS.iter().any(|(event, _)| {
                v["hooks"][*event]
                    .as_array()
                    .map(|groups| {
                        groups.iter().any(|g| {
                            g["hooks"]
                                .as_array()
                                .map(|handlers| handlers.iter().any(ours))
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    let relay = settings::hook_exe_path();
    HookStatus {
        installed,
        settings_path: path().display().to_string(),
        hook_path: relay.display().to_string(),
        hook_ready: relay.exists(),
        usage: false,
    }
}

pub fn preview(install: bool) -> Result<HookPreview, String> {
    let (current, fingerprint) = read()?;
    let next = changed(&current, install)?;
    Ok(HookPreview {
        diff: hooks::unified_diff(&pretty(&current), &pretty(&next)),
        backup: backup_path().display().to_string(),
        settings_path: path().display().to_string(),
        fingerprint,
    })
}

pub fn write(install: bool, fingerprint: &str) -> Result<String, String> {
    if install && !settings::hook_exe_path().exists() {
        return Err("coucou-hook.exe isn't installed yet".into());
    }
    let (current, actual) = read()?;
    if actual != fingerprint {
        return Err("hooks.json changed since the preview. Review the new diff.".into());
    }
    let next = changed(&current, install)?;
    let p = path();
    std::fs::create_dir_all(p.parent().ok_or("Missing Codex directory")?)
        .map_err(|e| e.to_string())?;
    let backup = backup_path();
    if p.exists() {
        std::fs::copy(&p, &backup).map_err(|e| format!("Backup failed: {e}"))?;
    }
    let temp = p.with_extension(format!("json.coucou-{}", std::process::id()));
    std::fs::write(&temp, format!("{}\n", pretty(&next))).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::rename(&temp, &p) {
        let _ = std::fs::remove_file(&temp);
        return Err(e.to_string());
    }
    Ok(if backup.exists() {
        backup.display().to_string()
    } else {
        "No previous file (new hooks.json)".into()
    })
}

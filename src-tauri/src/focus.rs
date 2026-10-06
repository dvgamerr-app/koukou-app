// "Open terminal" on the Finished card: bring the window the session runs in to
// the front — the VS Code window or the terminal it was started from, which is
// necessarily still open, since the session just finished in it.
//
// koukou-hook sends the session's process chain (bash → claude → shell → VS Code
// or Windows Terminal). The window is the first one owned by a process in that
// chain; when that process owns several (VS Code: one main process for every
// window), the title naming the project folder wins.

use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    VK_MENU,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumWindows, GetWindow, GetWindowLongW, GetWindowTextLengthW,
    GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible,
    SetForegroundWindow, ShowWindow, GWL_EXSTYLE, GW_OWNER, SW_RESTORE, WS_EX_TOOLWINDOW,
};

use crate::log;

/// A top-level window someone could be working in.
struct Candidate {
    hwnd: HWND,
    pid: u32,
    title: String,
}

/// Processes that are ancestors of nearly everything and own unrelated windows.
/// A console started from Explorer has it as a parent, and picking one of its
/// File Explorer windows would be worse than doing nothing.
const NOT_A_HOST: &[&str] = &["explorer.exe", "svchost.exe", "services.exe", "sihost.exe"];

/// Brings the session's window forward. False when it can't be found, so the
/// caller can fall back to opening the folder.
pub fn focus_session_window(pids: &[u32], console_hwnd: Option<isize>, cwd: Option<&str>) -> bool {
    let windows = top_level_windows();
    let host_pids: Vec<u32> = pids
        .iter()
        .copied()
        .filter(|&pid| process_name(pid).map(|n| !NOT_A_HOST.contains(&n.as_str())).unwrap_or(true))
        .collect();

    let chosen = pick(&host_pids, cwd, &windows).or_else(|| {
        // A classic console: the relay saw the window itself.
        let hwnd = HWND(console_hwnd? as *mut _);
        unsafe { (IsWindow(Some(hwnd)).as_bool() && IsWindowVisible(hwnd).as_bool()).then_some(hwnd) }
    });

    match chosen {
        Some(hwnd) => {
            let ok = bring_forward(hwnd);
            log::line(format!("open terminal: window found, foreground={ok}"));
            true
        }
        None => {
            log::line("open terminal: no window for this session");
            false
        }
    }
}

/// The window to bring forward: nearest process in the chain that owns one,
/// and among its windows the title that names the deepest part of `cwd`.
fn pick(pids: &[u32], cwd: Option<&str>, windows: &[Candidate]) -> Option<HWND> {
    // Deepest folder first: "billing-api" before "work" before "E:".
    let parts: Vec<String> = cwd
        .unwrap_or_default()
        .split(['\\', '/'])
        .filter(|p| !p.is_empty() && !p.ends_with(':'))
        .rev()
        .map(str::to_lowercase)
        .collect();

    for pid in pids {
        let owned: Vec<&Candidate> = windows.iter().filter(|w| w.pid == *pid).collect();
        if owned.is_empty() {
            continue;
        }
        // EnumWindows walks top to bottom, so on a tie the window used most
        // recently wins.
        let best = owned
            .iter()
            .min_by_key(|w| {
                let title = w.title.to_lowercase();
                parts.iter().position(|p| title.contains(p.as_str())).unwrap_or(usize::MAX)
            })
            .map(|w| w.hwnd);
        if best.is_some() {
            return best;
        }
    }
    None
}

fn top_level_windows() -> Vec<Candidate> {
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let list = unsafe { &mut *(lparam.0 as *mut Vec<Candidate>) };
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() {
                return BOOL(1);
            }
            // Dialogs and tool windows belong to a real window; skip them.
            if GetWindow(hwnd, GW_OWNER).map(|o| !o.is_invalid()).unwrap_or(false) {
                return BOOL(1);
            }
            if GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0 {
                return BOOL(1);
            }
            let len = GetWindowTextLengthW(hwnd);
            if len <= 0 {
                return BOOL(1);
            }
            let mut buf = vec![0u16; len as usize + 1];
            let n = GetWindowTextW(hwnd, &mut buf).max(0) as usize;
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            list.push(Candidate { hwnd, pid, title: String::from_utf16_lossy(&buf[..n]) });
        }
        BOOL(1)
    }

    let mut list: Vec<Candidate> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut list as *mut _ as isize));
    }
    list
}

/// `code.exe`, `windowsterminal.exe`… lower-case, or None if we may not look.
fn process_name(pid: u32) -> Option<String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len)
            .is_ok();
        let _ = CloseHandle(process);
        if !ok {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit(['\\', '/']).next().map(str::to_lowercase)
    }
}

/// Restores the window if minimised and makes it the foreground window.
///
/// Windows only lets the process that received the last input steal the
/// foreground. The click on the card normally makes that us; if the switch is
/// still refused, a synthetic Alt tap counts as input and the retry goes through.
fn bring_forward(hwnd: HWND) -> bool {
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        if SetForegroundWindow(hwnd).as_bool() {
            return true;
        }
        let key = |flags| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_MENU,
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let taps = [key(KEYBD_EVENT_FLAGS(0)), key(KEYEVENTF_KEYUP)];
        SendInput(&taps, std::mem::size_of::<INPUT>() as i32);
        let ok = SetForegroundWindow(hwnd).as_bool();
        let _ = BringWindowToTop(hwnd);
        ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(id: isize, pid: u32, title: &str) -> Candidate {
        Candidate { hwnd: HWND(id as *mut _), pid, title: title.into() }
    }

    #[test]
    fn the_project_window_of_the_nearest_host_wins() {
        // One VS Code main process owns every VS Code window.
        let windows = [
            win(1, 900, "main.rs - storefront - Visual Studio Code"),
            win(2, 900, "hooks.ts - koukou - Visual Studio Code"),
            win(3, 700, "Windows PowerShell"),
        ];
        // bash(100) → claude(200) → pwsh(300) → Code ptyHost(800) → Code(900)
        let chain = [100, 200, 300, 800, 900];
        let got = pick(&chain, Some(r"E:\koukou\windows"), &windows).unwrap();
        assert_eq!(got.0 as isize, 2, "the koukou window, by its folder name");
    }

    #[test]
    fn the_deepest_folder_beats_a_parent_folder() {
        let windows = [
            win(1, 900, "x - work - Visual Studio Code"),
            win(2, 900, "y - billing-api - Visual Studio Code"),
        ];
        let got = pick(&[900], Some("E:/work/billing-api"), &windows).unwrap();
        assert_eq!(got.0 as isize, 2);
    }

    #[test]
    fn no_title_match_still_finds_the_host_window() {
        // Windows Terminal: the title is the active tab, not the folder.
        let windows = [win(5, 600, "✳ Claude Code"), win(6, 999, "koukou - other app")];
        let got = pick(&[200, 300, 600], Some(r"E:\koukou"), &windows).unwrap();
        assert_eq!(got.0 as isize, 5, "a window of the chain beats a title match outside it");
    }

    #[test]
    fn nothing_in_the_chain_means_nothing() {
        let windows = [win(6, 999, "koukou - other app")];
        assert!(pick(&[200, 300], Some(r"E:\koukou"), &windows).is_none());
    }
}

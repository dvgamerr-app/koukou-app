//! Windows-only shortcuts; the hook thread never does webview work.
use std::cell::RefCell;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, OnceLock,
};
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    VK_APPS, VK_LMENU, VK_LWIN, VK_NONAME, VK_RWIN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
    KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN,
    WM_SYSKEYUP,
};

static ENABLED: AtomicBool = AtomicBool::new(true);
static EVENTS: OnceLock<mpsc::Sender<&'static str>> = OnceLock::new();
thread_local! {
    // Track swallowed downs so repeats and their corresponding ups stay swallowed.
    static CAPTURED: RefCell<[bool; 256]> = const { RefCell::new([false; 256]) };
}

pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

pub fn start(app: AppHandle, enabled: bool) {
    set_enabled(enabled);
    let (tx, rx) = mpsc::channel();
    if EVENTS.set(tx).is_err() {
        return;
    }
    std::thread::spawn(move || {
        for action in rx {
            let _ = app.emit("shortcut", action);
        }
    });
    std::thread::spawn(|| unsafe {
        let module = match GetModuleHandleW(None) {
            Ok(module) => module,
            Err(error) => {
                crate::log::line(format!("shortcuts: {error}"));
                return;
            }
        };
        let hook = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), Some(module.into()), 0) {
            Ok(hook) => hook,
            Err(error) => {
                crate::log::line(format!("shortcuts: {error}"));
                return;
            }
        };
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            DispatchMessageW(&msg);
        }
        let _ = UnhookWindowsHookEx(hook);
    });
}

unsafe extern "system" fn keyboard(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let key = unsafe { &*(l.0 as *const KBDLLHOOKSTRUCT) };
        let down = matches!(w.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
        let up = matches!(w.0 as u32, WM_KEYUP | WM_SYSKEYUP);
        if (down || up) && key.vkCode < 256 && !key.flags.contains(LLKHF_INJECTED) {
            let swallowed = CAPTURED.with(|captured| {
                let mut captured = captured.borrow_mut();
                let slot = &mut captured[key.vkCode as usize];
                if *slot {
                    if up {
                        *slot = false;
                    }
                    return true;
                }
                if !down || !ENABLED.load(Ordering::Relaxed) {
                    return false;
                }
                let win = unsafe {
                    GetAsyncKeyState(VK_LWIN.0 as i32) < 0 || GetAsyncKeyState(VK_RWIN.0 as i32) < 0
                };
                let action = if win && key.vkCode == VK_LMENU.0 as u32 {
                    "open"
                } else if win && key.vkCode == VK_APPS.0 as u32 {
                    "drop"
                } else {
                    return false;
                };
                *slot = true;
                // Mark the Win chord as used, preventing Start from opening on
                // release. Win up itself must pass through to avoid a stuck key.
                let inputs = [false, true].map(|up| INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VK_NONAME,
                            dwFlags: if up {
                                KEYEVENTF_KEYUP
                            } else {
                                Default::default()
                            },
                            ..Default::default()
                        },
                    },
                });
                unsafe {
                    SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
                }
                if let Some(tx) = EVENTS.get() {
                    let _ = tx.send(action);
                }
                true
            });
            if swallowed {
                return LRESULT(1);
            }
        }
    }
    unsafe { CallNextHookEx(None, code, w, l) }
}

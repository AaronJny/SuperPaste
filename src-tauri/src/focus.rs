use std::sync::Mutex;

// ============================================================================
// macOS Implementation
// ============================================================================
#[cfg(target_os = "macos")]
use objc::runtime::Object;
#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl};

#[cfg(target_os = "macos")]
static PREVIOUS_APP_PID: Mutex<Option<i32>> = Mutex::new(None);

#[cfg(target_os = "macos")]
pub fn save_frontmost_app() {
    unsafe {
        let workspace: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
        if workspace.is_null() {
            return;
        }

        let frontmost_app: *mut Object = msg_send![workspace, frontmostApplication];
        if frontmost_app.is_null() {
            return;
        }

        let pid: i32 = msg_send![frontmost_app, processIdentifier];
        let my_pid = std::process::id() as i32;

        if pid != my_pid && pid > 0 {
            if let Ok(mut guard) = PREVIOUS_APP_PID.lock() {
                *guard = Some(pid);
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub fn restore_previous_app() {
    let pid = {
        match PREVIOUS_APP_PID.lock() {
            Ok(guard) => *guard,
            Err(_) => None,
        }
    };

    let Some(pid) = pid else { return };

    unsafe {
        let running_app_class = class!(NSRunningApplication);
        let app: *mut Object = msg_send![
            running_app_class,
            runningApplicationWithProcessIdentifier: pid
        ];

        if app.is_null() {
            return;
        }

        const NS_APPLICATION_ACTIVATE_IGNORING_OTHER_APPS: usize = 1 << 1;
        let _success: bool = msg_send![
            app,
            activateWithOptions: NS_APPLICATION_ACTIVATE_IGNORING_OTHER_APPS
        ];
    }

    if let Ok(mut guard) = PREVIOUS_APP_PID.lock() {
        *guard = None;
    }
}

// ============================================================================
// Windows Implementation
// ============================================================================
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;
#[cfg(target_os = "windows")]
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow};

#[cfg(target_os = "windows")]
static PREVIOUS_HWND: Mutex<Option<isize>> = Mutex::new(None);

#[cfg(target_os = "windows")]
pub fn save_frontmost_app() {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0 != std::ptr::null_mut() {
            if let Ok(mut guard) = PREVIOUS_HWND.lock() {
                *guard = Some(hwnd.0 as isize);
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub fn restore_previous_app() {
    let hwnd_value = {
        match PREVIOUS_HWND.lock() {
            Ok(guard) => *guard,
            Err(_) => None,
        }
    };

    let Some(hwnd_value) = hwnd_value else { return };

    unsafe {
        let hwnd = HWND(hwnd_value as *mut std::ffi::c_void);

        // Get thread IDs for AttachThreadInput trick
        let foreground_thread = GetWindowThreadProcessId(GetForegroundWindow(), None);
        let current_thread = GetCurrentThreadId();

        // Attach threads to allow focus change
        if foreground_thread != current_thread {
            let _ = AttachThreadInput(current_thread, foreground_thread, true);
        }

        let _ = SetForegroundWindow(hwnd);

        // Detach threads
        if foreground_thread != current_thread {
            let _ = AttachThreadInput(current_thread, foreground_thread, false);
        }
    }

    if let Ok(mut guard) = PREVIOUS_HWND.lock() {
        *guard = None;
    }
}

// ============================================================================
// Linux Implementation (X11 via xdotool)
// ============================================================================
#[cfg(target_os = "linux")]
static PREVIOUS_WINDOW_ID: Mutex<Option<String>> = Mutex::new(None);

#[cfg(target_os = "linux")]
pub fn save_frontmost_app() {
    // Use xdotool to get active window ID
    if let Ok(output) = std::process::Command::new("xdotool")
        .args(["getactivewindow"])
        .output()
    {
        if output.status.success() {
            let window_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !window_id.is_empty() {
                if let Ok(mut guard) = PREVIOUS_WINDOW_ID.lock() {
                    *guard = Some(window_id);
                }
            }
        }
    }
}

#[cfg(target_os = "linux")]
pub fn restore_previous_app() {
    let window_id = {
        match PREVIOUS_WINDOW_ID.lock() {
            Ok(guard) => guard.clone(),
            Err(_) => None,
        }
    };

    let Some(window_id) = window_id else { return };

    // Use xdotool to activate the window
    let _ = std::process::Command::new("xdotool")
        .args(["windowactivate", &window_id])
        .spawn();

    if let Ok(mut guard) = PREVIOUS_WINDOW_ID.lock() {
        *guard = None;
    }
}

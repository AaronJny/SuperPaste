use crate::clipboard::{ClipboardPayload, ClipboardWatcher};
use crate::models::Settings;
use std::path::PathBuf;
use std::process::Command;
use tauri::Manager;

#[tauri::command]
pub async fn get_settings() -> Result<Settings, String> {
    Ok(Settings::default())
}

#[tauri::command]
pub async fn save_settings(settings: Settings) -> Result<(), String> {
    println!("Saving settings: {:?}", settings);
    Ok(())
}

#[tauri::command]
pub async fn hide_window(app: tauri::AppHandle, restore_focus: Option<bool>) -> Result<(), String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.send(crate::hide_panel(&handle, restore_focus.unwrap_or(true)));
    })
    .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "Panel action was interrupted".to_string())?
}

#[tauri::command]
pub async fn hide_window_on_blur(app: tauri::AppHandle) -> Result<(), String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        // Recheck at execution time: a queued blur must not hide a panel that
        // has already regained focus (for example after a quick reopen).
        let focused = handle
            .get_webview_window("main")
            .and_then(|window| window.is_focused().ok())
            .unwrap_or(false);
        #[cfg(target_os = "linux")]
        let active_window_owned = crate::focus::own_window_is_active();
        #[cfg(not(target_os = "linux"))]
        let active_window_owned = false;
        let result = if crate::focus::should_hide_on_blur(focused, active_window_owned) {
            // An external application now owns focus. Never steal it back.
            crate::hide_panel(&handle, false)
        } else {
            Ok(())
        };
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "Panel action was interrupted".to_string())?
}

#[tauri::command]
pub async fn show_window(app: tauri::AppHandle) -> Result<(), String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.send(crate::show_panel(&handle));
    })
    .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "Panel action was interrupted".to_string())?
}

#[tauri::command]
pub async fn pending_clipboard(
    watcher: tauri::State<'_, ClipboardWatcher>,
) -> Result<Vec<ClipboardPayload>, String> {
    watcher.pending()
}

#[tauri::command]
pub async fn acknowledge_clipboard(
    watcher: tauri::State<'_, ClipboardWatcher>,
    id: String,
) -> Result<(), String> {
    watcher.acknowledge(&id)
}

#[tauri::command]
pub async fn clipboard_status(
    watcher: tauri::State<'_, ClipboardWatcher>,
) -> Result<Option<String>, String> {
    watcher.status()
}

#[tauri::command]
pub async fn copy_to_clipboard(content: String, content_type: String) -> Result<(), String> {
    use arboard::Clipboard;
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;

    match content_type.as_str() {
        "text" => {
            clipboard.set_text(&content).map_err(|e| e.to_string())?;
        }
        "image" => {
            // Load image from path and set to clipboard
            let img = image::open(&content).map_err(|e| e.to_string())?;
            let rgba = img.to_rgba8();
            let (width, height) = rgba.dimensions();
            let img_data = arboard::ImageData {
                width: width as usize,
                height: height as usize,
                bytes: rgba.into_raw().into(),
            };
            clipboard.set_image(img_data).map_err(|e| e.to_string())?;
        }
        _ => return Err("Unsupported content type".to_string()),
    }

    Ok(())
}

#[tauri::command]
pub async fn delete_image_files(
    app: tauri::AppHandle,
    paths: Vec<String>,
    referenced_paths: Vec<String>,
) -> Result<(), String> {
    let images_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("images");
    let paths = paths.into_iter().map(PathBuf::from).collect::<Vec<_>>();
    let references = referenced_paths
        .into_iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    app.state::<ClipboardWatcher>()
        .delete_images(&images_dir, &paths, &references)
}

#[tauri::command]
pub async fn orphan_image_candidates(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let images_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("images");
    app.state::<ClipboardWatcher>()
        .orphan_candidates(&images_dir)
        .map(|paths| {
            paths
                .into_iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect()
        })
}

/// 模拟粘贴操作 (Cmd+V / Ctrl+V)
#[tauri::command]
pub async fn paste() -> Result<(), String> {
    // 短暂延迟确保焦点已恢复到目标应用
    std::thread::sleep(std::time::Duration::from_millis(100));

    #[cfg(target_os = "macos")]
    {
        // 使用 AppleScript 模拟 Cmd+V
        let script = r#"tell application "System Events" to keystroke "v" using command down"#;
        let output = Command::new("osascript")
            .args(["-e", script])
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
    }

    #[cfg(target_os = "windows")]
    {
        // Windows: 使用 PowerShell 模拟 Ctrl+V
        let output = Command::new("powershell")
            .args(["-Command", r#"Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"#])
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
    }

    #[cfg(target_os = "linux")]
    {
        // Linux: 使用 xdotool 模拟 Ctrl+V (需要安装 xdotool)
        let output = Command::new("xdotool")
            .args(["key", "ctrl+v"])
            .output()
            .map_err(|e| {
                format!(
                    "xdotool not found. Please install it: sudo apt install xdotool. Error: {}",
                    e
                )
            })?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
    }

    Ok(())
}

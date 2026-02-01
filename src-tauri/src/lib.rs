mod clipboard;
mod commands;
mod focus;
mod models;
mod tray;

use clipboard::ClipboardWatcher;
use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                                focus::restore_previous_app();
                            } else {
                                // 先保存当前活跃应用
                                focus::save_frontmost_app();
                                
                                // 根据屏幕尺寸动态设置窗口大小和位置
                                if let Ok(Some(monitor)) = window.current_monitor() {
                                    let monitor_size = monitor.size();
                                    let monitor_pos = monitor.position();
                                    
                                    // 窗口宽度为屏幕的 92%，高度为屏幕的 45%
                                    let win_width = (monitor_size.width as f64 * 0.92) as u32;
                                    let win_height = (monitor_size.height as f64 * 0.45).max(350.0) as u32;
                                    
                                    let _ = window.set_size(tauri::PhysicalSize::new(win_width, win_height));
                                    
                                    let x = monitor_pos.x + ((monitor_size.width - win_width) / 2) as i32;
                                    let y = monitor_pos.y + (monitor_size.height - win_height - 80) as i32;
                                    
                                    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
                                }
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Hide from dock on macOS
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Create system tray
            tray::create_tray(app)?;

            // Start clipboard watcher
            let watcher = ClipboardWatcher::new();
            watcher.start(app.handle().clone());

            // Register global shortcut
            app.global_shortcut()
                .register("CommandOrControl+Shift+V")
                .expect("Failed to register shortcut");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::hide_window,
            commands::show_window,
            commands::copy_to_clipboard,
            commands::delete_image_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
